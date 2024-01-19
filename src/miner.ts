import { Api, JsonRpc, RpcError } from "eosjs";
import { JsSignatureProvider } from "eosjs/dist/eosjs-jssig";
import "isomorphic-fetch"
import { TextEncoder, TextDecoder } from "util";
import { keccak256 } from 'ethereumjs-util';
import {logger} from "./logger";


export interface MinerConfig {
    privateKey?: string;
    minerAccount?: string;
    minerPermission?: string;
    rpcEndpoints?: Array<string>;
    lockGasPrice?: boolean;
    expireSec?: number;
}

export default class EosEvmMiner {
    rpc: JsonRpc;
    api: Api;
    sigProvider: JsSignatureProvider;
    publicKeys: string[];
    gasPrice: string = "0x22ecb25c00"; // 150Gwei
    pushCount: number = 0;
    poolTimer: NodeJS.Timeout;

    constructor(public readonly config: MinerConfig) {
        this.publicKeys = [];
        this.sigProvider = new JsSignatureProvider([this.config.privateKey]);
        this.poolTimer = setTimeout(() => this.refresh_endpoint_and_gasPrice(), 100);
    }

    async refresh_endpoint_and_gasPrice() {
        clearTimeout(this.poolTimer);
        if (this.publicKeys.length == 0) {
            this.publicKeys = await this.sigProvider.getAvailableKeys();
            if (this.publicKeys.length > 0) {
                console.log("miner's signing public key is " + this.publicKeys[0]);
            }
        }
        for (var i = 0; i < this.config.rpcEndpoints.length; ++i) {
            var rpc = new JsonRpc(this.config.rpcEndpoints[i], { fetch });
            var api = new Api({
                rpc: rpc,
                signatureProvider: this.sigProvider,
                textDecoder: new TextDecoder(),
                textEncoder: new TextEncoder(),
            });
            try {
                const result = await rpc.get_table_rows({
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
                this.api = api;
                break;
            } catch(e) {
                logger.error("Error getting gas price from " + this.config.rpcEndpoints[i] + ":" + e);
            }
        }
        this.poolTimer = setTimeout(() => this.refresh_endpoint_and_gasPrice(), 5000);
    }

    async eth_sendRawTransaction(params:any[]) {
        let timeStarted = Date.now();
        const trxcount = this.pushCount++;
        const rlptx:string = params[0].substr(2);

        const evm_trx = '0x'+keccak256(Buffer.from(rlptx, "hex")).toString("hex");
        logger.info(`Pushing tx #${trxcount}, evm_trx ${evm_trx}`);

        const sentTransaction = await this.api.transact(
            {
                actions: [
                    {
                        account: `eosio.evm`,
                        name: "pushtx",
                        authorization: [{
                            actor : this.config.minerAccount,
                            permission : this.config.minerPermission,
                        }],
                        data: { miner : this.config.minerAccount, rlptx }
                    }
                ],
            },
            {
                requiredKeys: this.publicKeys,
                blocksBehind: 3,
                expireSeconds: this.config.expireSec || 60,
            }
        ).then(x => {
            logger.info(`Pushed tx #${trxcount}`);
            logger.info(x);

            return true;
        }).catch(e => {
            logger.error(`Error pushing #${trxcount} #${evm_trx}`);
            logger.error(e);

            throw new Error(
                `error pushing #${trxcount} evm_trx ${evm_trx} from EVM miner: `
                + e.hasOwnProperty("details") ? e.details[0].message : e.hasOwnProperty("json") ? e.json.error.details[0].message : JSON.stringify(e)
            );
        });

        logger.info(`Tx #${trxcount} latency ${Date.now() - timeStarted}ms`);
        return evm_trx;
    }

    async eth_gasPrice(params:any[]){
        return this.gasPrice;
    }
}

