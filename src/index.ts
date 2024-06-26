require('dotenv').config();

import colors from "colors/safe";
import jayson from 'jayson';
import EosEvmMiner from './miner';
import {logger} from "./logger";

const { 
    PRIVATE_KEY, 
    MINER_ACCOUNT, 
    RPC_ENDPOINTS, 
    PORT = 50305, 
    EVM_ACCOUNT = "eosio.evm",
    EVM_SCOPE = "eosio.evm",
    MINER_PERMISSION = "active",
    GAS_PER_US = 74,
    EXPIRE_SEC = 60,
    MINER_FEE_MODE = "fixed", // default to fixed 0 fee
    FIXED_MINER_FEE = 0,
    GAS_TOKEN_EXCHANGE_RATE = 1, // If EOS is the gas token, the exchange rate is 1
    MINER_MARKUP_PERCENTAGE = 0,
    RETRY_TX = "true",
    PRICING_ENDPOINTS,
} = process.env;

const quit = (error:string) => {
    logger.error(error);
    process.exit(1);
}

if(!PRIVATE_KEY) quit('Missing PRIVATE_KEY');
if(!MINER_ACCOUNT) quit('Missing MINER_ACCOUNT');
if(!RPC_ENDPOINTS) quit('Missing RPC_ENDPOINTS');

const rpcEndpoints:Array<string> = RPC_ENDPOINTS.split('|');
if(!rpcEndpoints.length) quit('Not enough RPC_ENDPOINTS');

let retryTx:boolean = RETRY_TX === "true";

const eosEvmMiner = new EosEvmMiner({
    privateKey: PRIVATE_KEY,
    minerAccount: MINER_ACCOUNT,
    minerPermission: MINER_PERMISSION,
    rpcEndpoints,
    expireSec: +EXPIRE_SEC,
    minerFeeMode: MINER_FEE_MODE,
    fixedMinerFee: +FIXED_MINER_FEE,
    gasPerUs: +GAS_PER_US,
    minerMarkupPercentage: +MINER_MARKUP_PERCENTAGE,
    gasTokenExchangeRate: +GAS_TOKEN_EXCHANGE_RATE,
    evmAccount: EVM_ACCOUNT,
    evmScope: EVM_SCOPE,
    retryTx: retryTx,
    pricingEndpoings: PRICING_ENDPOINTS,
});

const server = new jayson.Server({
    eth_sendRawTransaction: function(params, callback) {
        eosEvmMiner.eth_sendRawTransaction(params).then((result:any) => {
            callback(null, result);
        }).catch((error:Error) => {
            callback({
                "code": -32000,
                "message": error.message
            });
        });
    },
    eth_gasPrice: function(params, callback) {
        eosEvmMiner.eth_gasPrice(params).then((result:any) => {
            callback(null, result);
        }).catch((error:Error) => {
            callback({
                "code": -32000,
                "message": error.message
            });
        });
    },
    eth_maxPriorityFeePerGas: function(params, callback) {
        eosEvmMiner.eth_maxPriorityFeePerGas(params).then((result:any) => {
            callback(null, result);
        }).catch((error:Error) => {
            callback({
                "code": -32000,
                "message": error.message
            });
        });
    }
});

server.http().listen(PORT);

logger.info(`

███████╗ ██████╗ ███████╗    ███████╗██╗   ██╗███╗   ███╗
██╔════╝██╔═══██╗██╔════╝    ██╔════╝██║   ██║████╗ ████║
█████╗  ██║   ██║███████╗    █████╗  ██║   ██║██╔████╔██║
██╔══╝  ██║   ██║╚════██║    ██╔══╝  ╚██╗ ██╔╝██║╚██╔╝██║
███████╗╚██████╔╝███████║    ███████╗ ╚████╔╝ ██║ ╚═╝ ██║
╚══════╝ ╚═════╝ ╚══════╝    ╚══════╝  ╚═══╝  ╚═╝     ╚═╝
    EOS EVM Miner listening @ http://127.0.0.1:${colors.blue(PORT.toString())}    
        Your miner account is ${colors.blue(MINER_ACCOUNT)}  
`);

export { server, eosEvmMiner };
