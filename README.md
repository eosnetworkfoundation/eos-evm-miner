# EOS EVM Miner

This tool allows you to accept Ethereum transactions and relay them to the EOS EVM.

For every transaction that you relay you will receive a reward in the form of EOS tokens.

## Environment Variables

| Name             | Description                                                                                                       | Default |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- | ------- |
| `PRIVATE_KEY`    | The private key of the miner account                                                                              |         |
| `MINER_ACCOUNT`  | The name of the miner account on the EOS Network                                                                  |         |
| `RPC_ENDPOINTS`  | A list of EOS RPC endpoints to connect to, comma-delimited                                                        |         |
| `PORT`           | The port to listen on for incoming Ethereum transactions                                                          | `50305` |
| `LOCK_GAS_PRICE` | If set to `true`, one a gas price is set, this miner will not hit the EOS API node again to fetch a new gas price | `true`  |

## Usage

> ⚠ **You must have registered your miner**
>
> You must have registered your miner account on the EOS Network. [Head over to our
> docs](https://docs.eosnetwork.com/docs/latest/eos-evm/mining/basic-setup) to learn all about
> mining, claiming your rewards, and more.

### Get the code

```bash
git clone https://github.com/eosnetworkfoundation/eos-evm-miner.git
cd eos-evm-miner
```

### Install dependencies

```bash
yarn
```

OR

```bash
npm install
```

### Environment Variables

Copy the `.env.example` file to `.env` and fill in the environment variables.

### Start mining

This command will build and run the node.

```bash
yarn mine
```

OR

```bash
npm run mine
```

If you want to just run the node without building, you can run:

```bash
yarn start
```

OR

```bash
npm run start
```

## Logging

This project uses [Winston](https://github.com/winstonjs/winston) for logging.

When you run the miner a directory called `logs` will be created in the root of the project.
Inside you will find two log files, `combined.log` and `error.log`.
