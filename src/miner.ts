import "isomorphic-fetch"
import { keccak256 } from 'ethereumjs-util';
import { logger } from "./logger";
import { Session } from '@wharfkit/session'
import { WalletPluginPrivateKey } from '@wharfkit/wallet-plugin-privatekey'
import { APIClient, SignedTransaction } from "@wharfkit/antelope"
import { PowerUpState, Resources } from "@wharfkit/resources"

export interface MinerConfig {
    privateKey: string;
    minerAccount: string;
    minerPermission: string;
    rpcEndpoints: Array<string>;
    expireSec: number;
    minerFeeMode: string;
    fixedMinerFee: number;
    gasPerUs: number;
    minerMarkupPercentage: number;
    gasTokenExchangeRate: number;
    evmAccount: string;
    evmScope: string;
    retryTx: boolean;
    pricingEndpoings: string;
}

export default class EosEvmMiner {
    gasPrice: number = parseInt("22ecb25c00", 16); // 150Gwei
    maxQueuedPrice: number = 0;
    evmVersion: number = 0;

    pushCount: number = 0;
    poolTimer: NodeJS.Timeout;
    session: Session;
    rpc: APIClient;
    resources: Resources;

    cpuCostPerUs: number = 314000000000; // ~314 Gwei, average EOS cost per us in a base utilization of 10% and miner utilization of 3%
    priorityFee: number = 0;
    priorityFeeQueue: Array<[number, number]> = [];

    priorityFeeMethod: () => Promise<number> = undefined;

    constructor(public readonly config: MinerConfig) {
        if (this.config.minerFeeMode) {
            switch (this.config.minerFeeMode.toLowerCase()) {
                case "cpu": {
                    this.priorityFeeMethod = this.priorityFeeFromCPU.bind(this);
                    break;
                }
                case "fixed": {
                    this.priorityFeeMethod = this.priorityFeeFromFixedValue.bind(this);
                    break;
                }
                default: {
                    logger.error("Unknown miner fee mode: " + this.config.minerFeeMode);
                }
            }
        }

        this.poolTimer = setTimeout(() => this.refresh(), 100);
    }

    check1559Enabled() {
        return this.evmVersion > 0;
    }

    getMaxQueuedPriorityFee() {
        // Return a price that is safe for a while.
        // The max of the queued price can make sure no matter when the tx is processed before or after the price change, the value is enough.
        return Math.max(this.priorityFee, ...this.priorityFeeQueue.map(x => x[1]));
    }

    getMaxQueuedBaseGasPrice() {
        // Return a price that is safe for a while.
        // The max of the queued price can make sure no matter when the tx is processed before or after the price change, the value is enough.
        return Math.max(this.gasPrice, this.maxQueuedPrice);
    }

    async priorityFeeFromCPU() {
        // Refresh cpu price first
        await this.queryCpuPrice();
        // Default to ~74.12 estimated from our benchmarks without OC
        let gas_per_us = this.config.gasPerUs;
        if (gas_per_us == 0) {
            gas_per_us = 1;
        }
        const fee = this.cpuCostPerUs / gas_per_us * (1 + this.config.minerMarkupPercentage/100) * this.config.gasTokenExchangeRate;
        return Math.ceil(fee);
    }

    async priorityFeeFromFixedValue() {
        const fee = this.config.fixedMinerFee;
        return Math.ceil(fee);
    }

    savePriorityFee(newPriorityFee) {
        const refTime = Date.now();

        this.priorityFeeQueue.push([refTime + 180 * 1000, newPriorityFee]);

        // Process queue
        let activeFee = undefined
        while (this.priorityFeeQueue.length > 0) {
            if (this.priorityFeeQueue[0][0] <= refTime) {
                activeFee = this.priorityFeeQueue.shift()
            }
            else {
                break;
            }
        }

        if (activeFee) {
            this.priorityFee = activeFee[1]
            logger.info("Priority fee activated: " + this.priorityFee);
        }
    }

    async calcPriorityFee() {
        // Calculate new priority fee based on config. 
        // Default fee to 0 if config not set properly.
        let newPriorityFee = 0;
        if (this.priorityFeeMethod && this.check1559Enabled()) {
            newPriorityFee = await this.priorityFeeMethod();
        }

        logger.info("New priority fee: " + newPriorityFee);
        this.savePriorityFee(newPriorityFee);
    }

    async queryContractStates() {
        try {
            const result = await this.rpc.v1.chain.get_table_rows({
                json: true,
                code: this.config.evmAccount,
                scope: this.config.evmScope,
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

            // The queue can only hold changes in the next 3 minutes. So it can have at most 180 rows if working properly.
            // We set the 180 limit there as well just in case.
            if (this.evmVersion >= 1) {
                const priceQueueResult = await this.rpc.v1.chain.get_table_rows({
                    json: true,
                    code: this.config.evmAccount,
                    scope: this.config.evmScope,
                    table: 'pricequeue',
                    limit: 180, 
                    reverse: false,
                    show_payer: false
                });

                if (result.rows.length > 0) {
                    const price_queue = result.rows.map(x => parseInt(x.price));
                    this.maxQueuedPrice = Math.max(...price_queue);
                }
                else {
                    this.maxQueuedPrice = 0;
                }
                logger.info("Max queued price: " + this.maxQueuedPrice);
            }
        } catch (e) {
            // Keep using old values if failed to get new ones.
            logger.error("Error getting contract states: " + e);
        }
    }

    async queryCpuPrice() {
        // We can disable this query if the fee is not calculated from CPU costs.
        // Leave it for now so we can log some CPU prices for reference.
        try {
            const powerup = await this.resources.v1.powerup.get_state()
            const sample = await this.resources.getSampledUsage()
            this.cpuCostPerUs = powerup.cpu.price_per_ms(sample, 100000) * 10000000000 // get 1s price multiplied by 1e10
            logger.info("cpu price per us: " + this.cpuCostPerUs);
        } catch (e) {
            // Keep using old values if failed to get new ones.
            logger.error("Error getting CPU price: " + e);
        }
    }

    async refresh() {
        clearTimeout(this.poolTimer);

        for (var i = 0; i < this.config.rpcEndpoints.length; ++i) {
            const rpc = new APIClient({ url: this.config.rpcEndpoints[i] })
            try {
                const info = await rpc.v1.chain.get_info();

                this.rpc = rpc;
                logger.info("setting RPC endpoint to " + this.config.rpcEndpoints[i]);

                if (this.config.pricingEndpoings) {
                    this.resources = new Resources({
                        api: new APIClient({ url: this.config.pricingEndpoings }),
                        sampleAccount: "eosio.reserv",
                    })
                }
                else {
                    this.resources = new Resources({
                        api: this.rpc,
                        sampleAccount: "eosio.reserv",
                    })
                }
                
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


                
                await this.queryContractStates();

                // Refresh price
                await this.calcPriorityFee();
                break;
            } catch (e) {
                logger.error("Error getting info from " + this.config.rpcEndpoints[i] + ": " + e);
            }
        }
        this.poolTimer = setTimeout(() => this.refresh(), 5000);
    }

    preparePushtx(rlptx: string) {
        return {
            actions: [
                {
                    account: this.config.evmAccount,
                    name: "pushtx",
                    authorization: [{
                        actor: this.config.minerAccount,
                        permission: this.config.minerPermission,
                    }],
                    data: {
                        miner: this.config.minerAccount,
                        rlptx,
                        ...this.check1559Enabled() && { min_inclusion_price: this.priorityFee }
                    }
                }
            ],
        }
    }

    async eth_sendRawTransaction(params: any[]) {
        if (!this.session) {
            return;
        }

        let timeStarted = Date.now();
        const trxcount = this.pushCount++;
        const rlptx: string = params[0].substr(2);

        const evm_trx = '0x' + keccak256(Buffer.from(rlptx, "hex")).toString("hex");
        logger.info(`Pushing tx #${trxcount}, evm_trx ${evm_trx}`);
        const sentTransaction = await this.session.transact(
            this.preparePushtx(rlptx),
            {
                expireSeconds: this.config.expireSec || this.config.expireSec,
                broadcast: false
            }
        ).then(async result => {
            const signed = SignedTransaction.from({
                ...result.resolved.transaction,
                signatures: result.signatures,
            })

            result.response = await this.rpc.v1.chain.send_transaction2(signed, {
                return_failure_trace: false,
                retry_trx: this.config.retryTx,
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
        // Return a price that will be safe for a while by using the max stored price in both queue.
        // The queued base price and priority fee should be 0 when 1559 not enabled. 
        // In that case, the return value should be the fixed valued stored in the contract as before.
        const price = this.getMaxQueuedBaseGasPrice() + this.getMaxQueuedPriorityFee()
        return "0x" + price.toString(16);
    }

    async eth_maxPriorityFeePerGas(params: any[]) {
        // Return max stored proirity fees so that this value is safe for a while
        // The return value shuld be 0x0 if 1559 not enabled.
        return "0x" + this.getMaxQueuedPriorityFee().toString(16);
    }
}

