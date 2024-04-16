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

    async calcCpuPrice() {
        const powerup = await this.resources.v1.powerup.get_state()
        const sample = await this.resources.getSampledUsage()
        this.cpuCostPerUs = powerup.cpu.price_per_us(sample, 1)
        logger.error("cpu price per us:" + this.cpuCostPerUs);
    }

    async calcPriorityFee() {
        const lastPriorityFee = this.priorityFee;
        if (this.check1559Enabled()) {
            const gas_per_us = 74; // ~74.12 estimated from our benchmarks without OC
            // The default value should be around 4.24 Gwei.
            this.priorityFee = Math.ceil(this.cpuCostPerUs/gas_per_us);
        }
        else {
            this.priorityFee = 0;
        }

        logger.info("New priority fee:" + this.priorityFee);

        // Only save prices in 60s.
        const newQueue = this.priorityFeeQueue.filter(x=>x[0] > Date.now() - 60*1000);
        // Always leave at least one old value to avoid sudden changes.
        if (newQueue.length == 0) {
            newQueue.push([Date.now() - 1, lastPriorityFee])
        }
        newQueue.push([Date.now(), this.priorityFee]);
    
        this.priorityFeeQueue = newQueue;

        // We enforce the minimum fee in the queue so that the user can make calls with recently queried fee.
        this.enforcedPriorityFee = Math.min(...this.priorityFeeQueue.map(x=>x[1]));

        logger.info("Priority enforced:" + this.priorityFee);
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
                    api: this.rpc
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
                    data: { miner: this.config.minerAccount, rlptx }
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
        const max_price = Math.max(this.gasPrice, this.maxQueuedPrice);
        return "0x" + max_price.toString(16);
    }

    async eth_maxPriorityFeePerGas(params: any[]) {
        return "0x" + this.priorityFee.toString(16);
    }
}

