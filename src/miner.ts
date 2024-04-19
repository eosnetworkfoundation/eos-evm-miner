import "isomorphic-fetch"
import { keccak256 } from 'ethereumjs-util';
import { logger } from "./logger";
import { Session } from '@wharfkit/session'
import { WalletPluginPrivateKey } from '@wharfkit/wallet-plugin-privatekey'
import { APIClient, SignedTransaction } from "@wharfkit/antelope"
import { PowerUpState, Resources } from "@wharfkit/resources"

export interface MinerConfig {
    privateKey?: string;
    minerAccount?: string;
    minerPermission?: string;
    rpcEndpoints?: Array<string>;
    lockGasPrice?: boolean;
    expireSec?: number;
    minerFeeMode?: string;
    minerFeeParameter?: number;
}

export default class EosEvmMiner {
    gasPrice: number = parseInt("22ecb25c00",16); // 150Gwei
    maxQueuedPrice: number = parseInt("22ecb25c00",16); // 150Gwei
    evmVersion: number = 0;
    
    pushCount: number = 0;
    poolTimer: NodeJS.Timeout;
    session: Session;
    rpc: APIClient;
    resources: Resources;

    cpuCostPerUs: number = 314000000000; // ~314 Gwei, average EOS cost per us in a base utilization of 10% and miner utilization of 3%
    priorityFee: number = 0;
    enforcedPriorityFee: number = 0;
    priorityFeeQueue: Array<[number, number]> = []; 

    constructor(public readonly config: MinerConfig) {
        this.poolTimer = setTimeout(() => this.refresh(), 100);
    }

    async queryContractStates() {
        try {
            const result = await this.rpc.v1.chain.get_table_rows({
                json: true,
                code: `eosio.evm`,
                scope: `eosio.evm`,
                table: 'config',
                limit: 1,
                reverse: false,
                show_payer: false
            });
            this.gasPrice = parseInt(result.rows[0].gas_price);
            logger.info("Gas price: " + this.gasPrice);

            if (result.rows[0].evm_version != undefined) {
                this.evmVersion = parseInt(result.rows[0].evm_version);
                logger.info("EVM version: " + this.evmVersion);
            }
            else {
                this.evmVersion = 0;
                logger.info("EVM version defaulted to: " + this.evmVersion);
            }

            if (result.rows[0].base_price_queue) {
                const price_queue = result.rows[0].base_price_queue.map(x=>parseInt(x));
                this.maxQueuedPrice = Math.max(price_queue);
            }
            else {
                this.maxQueuedPrice = 0;
            }
            logger.info("Max queued price: " + this.maxQueuedPrice);
        } catch (e) {
            // Keep using old gas values if failed to get new ones.
            logger.error("Error getting price:" + e);
        }
    }

    check1559Enabled() {
        return this.evmVersion > 0;
    }

    getEnforcedPriorityFee() {
        // We will only enforce the lowest price in the queue. 
        // In this way, no matter the user specify the current or earlier value, the tx will go through.
        return Math.min(...this.priorityFeeQueue.map(x=>x[1]));
    }

    getSafeGasPrice() {
        // Return a price that is safe for a while.
        // The max of the queued price can make sure no matter when the tx is processed before or after the price change, the value is enough.
        return Math.max(this.gasPrice, this.maxQueuedPrice);
    }

    async calcCpuPrice() {
        const powerup = await this.resources.v1.powerup.get_state()
        const sample = await this.resources.getSampledUsage()
        this.cpuCostPerUs = powerup.cpu.price_per_ms(sample, 100000) * 10000000000 // get 1s price multiplied by 1e10
        logger.info("cpu price per us:" + this.cpuCostPerUs);
    }

    savePriorityFee(newPriorityFee) {
        const lastPriorityFee = this.priorityFee;
        this.priorityFee = newPriorityFee;

        // Only save prices in 60s.
        const newQueue = this.priorityFeeQueue.filter(x=>x[0] > Date.now() - 60*1000);
        // Always leave at least one old value to avoid sudden changes.
        if (newQueue.length == 0) {
            newQueue.push([Date.now() - 1, lastPriorityFee])
        }
        newQueue.push([Date.now(), this.priorityFee]);

        this.priorityFeeQueue = newQueue;
    }

    priorityFeeFromCPU() {
        // Default to ~74.12 estimated from our benchmarks without OC
        let gas_per_us = this.config.minerFeeParameter? this.config.minerFeeParameter : 74;
        if (gas_per_us == 0) {
            gas_per_us = 1;
        }
        const fee = this.cpuCostPerUs/gas_per_us;
        return Math.ceil(fee);
    }

    priorityFeeFromProportion() {
        const proportion = this.config.minerFeeParameter? this.config.minerFeeParameter : 0;
        const fee = this.gasPrice * proportion;
        return Math.ceil(fee);
    }

    priorityFeeFromFixedValue() {
        const fee = this.config.minerFeeParameter? this.config.minerFeeParameter : 0;
        return Math.ceil(fee);
    }

    async calcPriorityFee() {
        // Calculate new priority fee based on config. 
        // Default fee to 0 if config not set properly.
        let newPriorityFee = 0;
        if (this.check1559Enabled()) {
            if (this.config.minerFeeMode) {
                switch (this.config.minerFeeMode.toLowerCase()) {
                    case "cpu": {
                        newPriorityFee = this.priorityFeeFromCPU();
                        break;
                    }
                    case "proportion": {
                        newPriorityFee = this.priorityFeeFromProportion();
                        break;
                    }
                    case "fixed": {
                        newPriorityFee = this.priorityFeeFromFixedValue();
                        break;
                    }
                    default : {
                        logger.error("Unknown miner fee mode: " + this.config.minerFeeMode);
                    }
                } 
            }
        }


        logger.info("New priority fee:" + newPriorityFee);
        this.savePriorityFee(newPriorityFee);   

        this.enforcedPriorityFee = this.getEnforcedPriorityFee();
        logger.info("Priority enforced:" + this.enforcedPriorityFee);
    }   

    async refresh() {
        clearTimeout(this.poolTimer);

        for (var i = 0; i < this.config.rpcEndpoints.length; ++i) {
            const rpc = new APIClient({ url: this.config.rpcEndpoints[i] })
            try {
                const info = await rpc.v1.chain.get_info();
                
                this.rpc = rpc;
                logger.info("setting RPC endpoint to " + this.config.rpcEndpoints[i]);

                this.resources = new Resources({
                    api: this.rpc,
                    sampleAccount: "eosio.reserv",
                })

                const session = new Session({
                    actor: this.config.minerAccount,
                    permission: this.config.minerPermission,
                    chain: {
                        id: info.chain_id,
                        url: this.config.rpcEndpoints[i]
                    },
                    walletPlugin: new WalletPluginPrivateKey(this.config.privateKey),
                })
                this.session = session;
                
                // Call without await.
                // Just make sure those states got updated frequently. 
                // It's fine that some calculation is based on old data not yet refreshed in other calls.
                this.calcCpuPrice();
                this.queryContractStates();
                this.calcPriorityFee();

                break;
            } catch (e) {
                logger.error("Error getting info from " + this.config.rpcEndpoints[i] + ":" + e);
            }
        }
        this.poolTimer = setTimeout(() => this.refresh(), 5000);
    }

    preparePushtx(rlptx: string) {
        return {
            actions: [
                {
                    account: `eosio.evm`,
                    name: "pushtx",
                    authorization: [{
                        actor: this.config.minerAccount,
                        permission: this.config.minerPermission,
                    }],
                    data: { miner: this.config.minerAccount, rlptx }
                }
            ],
        }
    }

    preparePushtxWithPriorityFee(rlptx: string) {
        
        return {
            actions: [
                {
                    account: `eosio.evm`,
                    name: "pushtx",
                    authorization: [{
                        actor: this.config.minerAccount,
                        permission: this.config.minerPermission,
                    }],
                    data: { miner: this.config.minerAccount, rlptx, min_inclusion_price:this.enforcedPriorityFee }
                }
            ],
        }
    }

    async eth_sendRawTransaction(params: any[]) {
        let timeStarted = Date.now();
        const trxcount = this.pushCount++;
        const rlptx: string = params[0].substr(2);

        const evm_trx = '0x' + keccak256(Buffer.from(rlptx, "hex")).toString("hex");
        logger.info(`Pushing tx #${trxcount}, evm_trx ${evm_trx}`);
        const sentTransaction = await this.session.transact(
            this.check1559Enabled() ? this.preparePushtxWithPriorityFee(rlptx) : this.preparePushtx(rlptx),
            {
                expireSeconds: this.config.expireSec || 60,
                broadcast: false
            }
        ).then(async result => {
            const signed = SignedTransaction.from({
                ...result.resolved.transaction,
                signatures: result.signatures,
            })

            result.response = await this.rpc.v1.chain.send_transaction2(signed, {
                return_failure_trace: false,
                retry_trx: false,
            })
            return result
        })
            .then(x => {
                logger.info(`Pushed tx #${trxcount}`);
                logger.info(x);

                return true;
            }).catch(e => {
                logger.error(`Error pushing #${trxcount} #${evm_trx}`);
                logger.error(e);

                throw new Error(
                    `error pushing #${trxcount} evm_trx ${evm_trx} from EVM miner: `
                        + e.hasOwnProperty("details") ? e.details[0].message : JSON.stringify(e)
                );
            });

        logger.info(`Tx #${trxcount} latency ${Date.now() - timeStarted}ms`);
        return evm_trx;
    }

    async eth_gasPrice(params: any[]) {
        // Reference price = a price that will be safe for a while + current priority fee
        const price = this.getSafeGasPrice() + this.priorityFee
        return "0x" + price.toString(16);
    }

    async eth_maxPriorityFeePerGas(params: any[]) {
        // Reference priority fee = current fee
        return "0x" + this.priorityFee.toString(16);
    }
}

