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
    currentRpcEndpoint: number = 0;
    rpc: JsonRpc;
    api: Api;
    lastGetTableCallTime: number = 0;
    gasPrice: string = "0x1";
    pushCount: number = 0;

    constructor(public readonly config: MinerConfig) {
        this.currentRpcEndpoint = this.config.rpcEndpoints.length - 1;
        this.swapRpcEndpoint();
    }

    swapRpcEndpoint() {
        this.currentRpcEndpoint = (this.currentRpcEndpoint + 1) % this.config.rpcEndpoints.length;
        this.rpc = new JsonRpc(this.config.rpcEndpoints[this.currentRpcEndpoint], { fetch });
        this.api = new Api({
            rpc: this.rpc,
            signatureProvider: new JsSignatureProvider([this.config.privateKey]),
            textDecoder: new TextDecoder(),
            textEncoder: new TextEncoder(),
        });
    }

    async eth_sendRawTransaction(params:any[]) {
        let timeStarted = Date.now();
        this.pushCount++;
        logger.info(`Pushing tx #${this.pushCount} to ${this.config.rpcEndpoints[this.currentRpcEndpoint]}`);

        const rlptx:string = params[0].substr(2);
        const sentTransaction = await this.api.transact(
            {
                actions: [
                    {
                        account: `eosio.evm`,
                        name: "pushtx",
                        authorization: [{
                            actor : this.config.minerAccount,
                            permission : "active",
                        }],
                        data: { miner : this.config.minerAccount, rlptx }
                    }
                ],
            },
            {
                blocksBehind: 3,
                expireSeconds: this.config.expireSec || 60,
            }
        ).then(x => {
            logger.info(`Pushed tx to ${this.config.rpcEndpoints[this.currentRpcEndpoint]}`);
            logger.info(x);
            return true;
        }).catch(e => {
            logger.error(`Error pushing #${this.pushCount} to ${this.config.rpcEndpoints[this.currentRpcEndpoint]}`);
            logger.error(e);
            this.swapRpcEndpoint();

            throw new Error("There was an error pushing this transaction from this EOS EVM miner.");
        });

        logger.info(`Latency for #${this.pushCount}: ${Date.now() - timeStarted}ms`);

        return '0x'+keccak256(Buffer.from(rlptx, "hex"));
    }

    async eth_gasPrice(params:any[]){
        const timeSinceLastCall = Date.now() - this.lastGetTableCallTime;
        if (!(this.config.lockGasPrice && this.gasPrice !== "0x1") && timeSinceLastCall >= 1000 ) {

            try {
                const result = await this.rpc.get_table_rows({
                    json: true,
                    code: `eosio.evm`,
                    scope: `eosio.evm`,
                    table: 'config',
                    limit: 1,
                    reverse: false,
                    show_payer: false
                });
                this.gasPrice = "0x" + parseInt(result.rows[0].gas_price).toString(16);
                this.lastGetTableCallTime = Date.now();
            } catch(e) {
                logger.error("Error getting gas price from nodeos: " + e);
                this.swapRpcEndpoint();

                throw new Error("There was an error getting the gas price from this EOS EVM miner.");
            }
        }

        logger.info("Gas price: " + this.gasPrice);
        return this.gasPrice;
    }
}

