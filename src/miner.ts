import "isomorphic-fetch"
import { keccak256 } from 'ethereumjs-util';
import { logger } from "./logger";
import { Session } from '@wharfkit/session'
import { WalletPluginPrivateKey } from '@wharfkit/wallet-plugin-privatekey'
import { APIClient, SignedTransaction } from "@wharfkit/antelope"


export interface MinerConfig {
    privateKey?: string;
    minerAccount?: string;
    minerPermission?: string;
    rpcEndpoints?: Array<string>;
    lockGasPrice?: boolean;
    expireSec?: number;
}

export default class EosEvmMiner {
    gasPrice: string = "0x22ecb25c00"; // 150Gwei
    pushCount: number = 0;
    poolTimer: NodeJS.Timeout;
    session: Session;
    rpc: APIClient;

    constructor(public readonly config: MinerConfig) {
        this.poolTimer = setTimeout(() => this.refresh_endpoint_and_gasPrice(), 100);
    }

    async refresh_endpoint_and_gasPrice() {
        clearTimeout(this.poolTimer);

        for (var i = 0; i < this.config.rpcEndpoints.length; ++i) {
            const rpc = new APIClient({ url: this.config.rpcEndpoints[i] })
            try {
                const info = await rpc.v1.chain.get_info()
                const result = await rpc.v1.chain.get_table_rows({
                    json: true,
                    code: `eosio.evm`,
                    scope: `eosio.evm`,
                    table: 'config',
                    limit: 1,
                    reverse: false,
                    show_payer: false
                });
                this.gasPrice = "0x" + parseInt(result.rows[0].gas_price).toString(16);
                logger.info("Gas price: " + this.gasPrice);
                logger.info("setting RPC endpoint to " + this.config.rpcEndpoints[i]);
                this.rpc = rpc;

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

                break;
            } catch (e) {
                logger.error("Error getting gas price from " + this.config.rpcEndpoints[i] + ":" + e);
            }
        }
        this.poolTimer = setTimeout(() => this.refresh_endpoint_and_gasPrice(), 5000);
    }

    async eth_sendRawTransaction(params: any[]) {
        let timeStarted = Date.now();
        const trxcount = this.pushCount++;
        const rlptx: string = params[0].substr(2);

        const evm_trx = '0x' + keccak256(Buffer.from(rlptx, "hex")).toString("hex");
        logger.info(`Pushing tx #${trxcount}, evm_trx ${evm_trx}`);
        const sentTransaction = await this.session.transact(
            {
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
            },
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
                retry_trx_num_blocks: 1
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
        return this.gasPrice;
    }
}

