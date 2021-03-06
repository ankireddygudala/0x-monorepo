import { BlockchainLifecycle } from '@0xproject/dev-utils';
import { Callback, ErrorCallback, NextCallback, Subprovider } from '@0xproject/subproviders';
import { Web3Wrapper } from '@0xproject/web3-wrapper';
import { CallData, JSONRPCRequestPayload, Provider, TxData } from 'ethereum-types';
import * as _ from 'lodash';
import { Lock } from 'semaphore-async-await';

import { constants } from './constants';
import { getTracesByContractAddress } from './trace';
import { BlockParamLiteral, TraceInfo, TraceInfoExistingContract, TraceInfoNewContract } from './types';

interface MaybeFakeTxData extends TxData {
    isFakeTransaction?: boolean;
}

const BLOCK_GAS_LIMIT = 6000000;

export interface TraceCollectionSubproviderConfig {
    shouldCollectTransactionTraces: boolean;
    shouldCollectCallTraces: boolean;
    shouldCollectGasEstimateTraces: boolean;
}

// Because there is no notion of a call trace in the Ethereum rpc - we collect them in a rather non-obvious/hacky way.
// On each call - we create a snapshot, execute the call as a transaction, get the trace, revert the snapshot.
// That allows us to avoid influencing test behaviour.

/**
 * This class implements the [web3-provider-engine](https://github.com/MetaMask/provider-engine) subprovider interface.
 * It collects traces of all transactions that were sent and all calls that were executed through JSON RPC.
 */
export class TraceCollectionSubprovider extends Subprovider {
    // Lock is used to not accept normal transactions while doing call/snapshot magic because they'll be reverted later otherwise
    private _lock = new Lock();
    private _defaultFromAddress: string;
    private _web3Wrapper!: Web3Wrapper;
    private _traceInfos: TraceInfo[] = [];
    private _isEnabled = true;
    private _config: TraceCollectionSubproviderConfig;
    /**
     * Instantiates a TraceCollectionSubprovider instance
     * @param defaultFromAddress default from address to use when sending transactions
     */
    constructor(defaultFromAddress: string, config: TraceCollectionSubproviderConfig) {
        super();
        this._defaultFromAddress = defaultFromAddress;
        this._config = config;
    }
    /**
     * Returns all trace infos collected by the subprovider so far
     */
    public getCollectedTraceInfos(): TraceInfo[] {
        return this._traceInfos;
    }
    /**
     * Starts trace collection
     */
    public start(): void {
        this._isEnabled = true;
    }
    /**
     * Stops trace collection
     */
    public stop(): void {
        this._isEnabled = false;
    }
    /**
     * This method conforms to the web3-provider-engine interface.
     * It is called internally by the ProviderEngine when it is this subproviders
     * turn to handle a JSON RPC request.
     * @param payload JSON RPC payload
     * @param next Callback to call if this subprovider decides not to handle the request
     * @param end Callback to call if subprovider handled the request and wants to pass back the request.
     */
    // tslint:disable-next-line:prefer-function-over-method async-suffix
    public async handleRequest(payload: JSONRPCRequestPayload, next: NextCallback, end: ErrorCallback): Promise<void> {
        if (this._isEnabled) {
            switch (payload.method) {
                case 'eth_sendTransaction':
                    if (!this._config.shouldCollectTransactionTraces) {
                        next();
                    } else {
                        const txData = payload.params[0];
                        next(this._onTransactionSentAsync.bind(this, txData));
                    }
                    return;

                case 'eth_call':
                    if (!this._config.shouldCollectCallTraces) {
                        next();
                    } else {
                        const callData = payload.params[0];
                        next(this._onCallOrGasEstimateExecutedAsync.bind(this, callData));
                    }
                    return;

                case 'eth_estimateGas':
                    if (!this._config.shouldCollectGasEstimateTraces) {
                        next();
                    } else {
                        const estimateGasData = payload.params[0];
                        next(this._onCallOrGasEstimateExecutedAsync.bind(this, estimateGasData));
                    }
                    return;

                default:
                    next();
                    return;
            }
        } else {
            next();
            return;
        }
    }
    /**
     * Set's the subprovider's engine to the ProviderEngine it is added to.
     * This is only called within the ProviderEngine source code, do not call
     * directly.
     */
    public setEngine(engine: Provider): void {
        super.setEngine(engine);
        this._web3Wrapper = new Web3Wrapper(engine);
    }
    private async _onTransactionSentAsync(
        txData: MaybeFakeTxData,
        err: Error | null,
        txHash: string | undefined,
        cb: Callback,
    ): Promise<void> {
        if (!txData.isFakeTransaction) {
            // This transaction is a usual transaction. Not a call executed as one.
            // And we don't want it to be executed within a snapshotting period
            await this._lock.acquire();
        }
        const NULL_ADDRESS = '0x0';
        if (_.isNull(err)) {
            const toAddress =
                _.isUndefined(txData.to) || txData.to === NULL_ADDRESS ? constants.NEW_CONTRACT : txData.to;
            await this._recordTxTraceAsync(toAddress, txData.data, txHash as string);
        } else {
            const latestBlock = await this._web3Wrapper.getBlockWithTransactionDataAsync(BlockParamLiteral.Latest);
            const transactions = latestBlock.transactions;
            for (const transaction of transactions) {
                const toAddress =
                    _.isUndefined(txData.to) || txData.to === NULL_ADDRESS ? constants.NEW_CONTRACT : txData.to;
                await this._recordTxTraceAsync(toAddress, transaction.input, transaction.hash);
            }
        }
        if (!txData.isFakeTransaction) {
            // This transaction is a usual transaction. Not a call executed as one.
            // And we don't want it to be executed within a snapshotting period
            this._lock.release();
        }
        cb();
    }
    private async _onCallOrGasEstimateExecutedAsync(
        callData: Partial<CallData>,
        err: Error | null,
        callResult: string,
        cb: Callback,
    ): Promise<void> {
        await this._recordCallOrGasEstimateTraceAsync(callData);
        cb();
    }
    private async _recordTxTraceAsync(address: string, data: string | undefined, txHash: string): Promise<void> {
        await this._web3Wrapper.awaitTransactionMinedAsync(txHash);
        const trace = await this._web3Wrapper.getTransactionTraceAsync(txHash, {
            disableMemory: true,
            disableStack: false,
            disableStorage: true,
        });
        const tracesByContractAddress = getTracesByContractAddress(trace.structLogs, address);
        const subcallAddresses = _.keys(tracesByContractAddress);
        if (address === constants.NEW_CONTRACT) {
            for (const subcallAddress of subcallAddresses) {
                let traceInfo: TraceInfoNewContract | TraceInfoExistingContract;
                if (subcallAddress === 'NEW_CONTRACT') {
                    const traceForThatSubcall = tracesByContractAddress[subcallAddress];
                    traceInfo = {
                        subtrace: traceForThatSubcall,
                        txHash,
                        address: subcallAddress,
                        bytecode: data as string,
                    };
                } else {
                    const runtimeBytecode = await this._web3Wrapper.getContractCodeAsync(subcallAddress);
                    const traceForThatSubcall = tracesByContractAddress[subcallAddress];
                    traceInfo = {
                        subtrace: traceForThatSubcall,
                        txHash,
                        address: subcallAddress,
                        runtimeBytecode,
                    };
                }
                this._traceInfos.push(traceInfo);
            }
        } else {
            for (const subcallAddress of subcallAddresses) {
                const runtimeBytecode = await this._web3Wrapper.getContractCodeAsync(subcallAddress);
                const traceForThatSubcall = tracesByContractAddress[subcallAddress];
                const traceInfo: TraceInfoExistingContract = {
                    subtrace: traceForThatSubcall,
                    txHash,
                    address: subcallAddress,
                    runtimeBytecode,
                };
                this._traceInfos.push(traceInfo);
            }
        }
    }
    private async _recordCallOrGasEstimateTraceAsync(callData: Partial<CallData>): Promise<void> {
        // We don't want other transactions to be exeucted during snashotting period, that's why we lock the
        // transaction execution for all transactions except our fake ones.
        await this._lock.acquire();
        const blockchainLifecycle = new BlockchainLifecycle(this._web3Wrapper);
        await blockchainLifecycle.startAsync();
        const fakeTxData: MaybeFakeTxData = {
            gas: BLOCK_GAS_LIMIT,
            isFakeTransaction: true, // This transaction (and only it) is allowed to come through when the lock is locked
            ...callData,
            from: callData.from || this._defaultFromAddress,
        };
        try {
            const txHash = await this._web3Wrapper.sendTransactionAsync(fakeTxData);
            await this._web3Wrapper.awaitTransactionMinedAsync(txHash);
        } catch (err) {
            // Even if this transaction failed - we've already recorded it's trace.
            _.noop();
        }
        await blockchainLifecycle.revertAsync();
        this._lock.release();
    }
}
