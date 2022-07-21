import { BigNumber } from '@ethersproject/bignumber';
import { Token } from '@uniswap/sdk-core';
import { Pair } from '@uniswap/v2-sdk';
import { FeeAmount, Pool } from '@uniswap/v3-sdk';
import _ from 'lodash';
import { WRAPPED_NATIVE_CURRENCY } from '../../../..';
import { IV2PoolProvider } from '../../../../providers/v2/pool-provider';
import { IV3PoolProvider } from '../../../../providers/v3/pool-provider';
import { ChainId } from '../../../../util';
import { CurrencyAmount } from '../../../../util/amounts';
import { log } from '../../../../util/log';
import { MixedRouteWithValidQuote } from '../../entities/route-with-valid-quote';
import {
  IGasModel,
  IMixedRouteGasModelFactory,
  usdGasTokensByChain,
} from '../gas-model';
import {
  BASE_SWAP_COST as BASE_SWAP_COST_V2,
  COST_PER_EXTRA_HOP as COST_PER_EXTRA_HOP_V2,
} from '../v2/v2-heuristic-gas-model';
import {
  BASE_SWAP_COST,
  COST_PER_HOP,
  COST_PER_INIT_TICK,
} from '../v3/gas-costs';

// Cost for crossing an uninitialized tick.
const COST_PER_UNINIT_TICK = BigNumber.from(0);

/**
 * Computes a gas estimate for a V3 swap using heuristics.
 * Considers number of hops in the route, number of ticks crossed
 * and the typical base cost for a swap.
 *
 * We get the number of ticks crossed in a swap from the QuoterV2
 * contract.
 *
 * We compute gas estimates off-chain because
 *  1/ Calling eth_estimateGas for a swaps requires the caller to have
 *     the full balance token being swapped, and approvals.
 *  2/ Tracking gas used using a wrapper contract is not accurate with Multicall
 *     due to EIP-2929. We would have to make a request for every swap we wanted to estimate.
 *  3/ For V2 we simulate all our swaps off-chain so have no way to track gas used.
 *
 * @export
 * @class V3HeuristicGasModelFactory
 */
export class MixedRouteHeuristicGasModelFactory extends IMixedRouteGasModelFactory {
  constructor() {
    super();
  }

  public async buildGasModel(
    chainId: ChainId,
    gasPriceWei: BigNumber,
    V3poolProvider: IV3PoolProvider,
    // @ts-ignore[TS6133] /// @dev ignore unused parameter for now since we might need it in later implementation and don't want to refactor
    V2poolProvider: IV2PoolProvider,
    token: Token
  ): Promise<IGasModel<MixedRouteWithValidQuote>> {
    const usdPool: Pool = await this.getHighestLiquidityUSDPool(
      chainId,
      V3poolProvider
    );

    // If our quote token is WETH, we don't need to convert our gas use to be in terms
    // of the quote token in order to produce a gas adjusted amount.
    // We do return a gas use in USD however, so we still convert to usd.
    const nativeCurrency = WRAPPED_NATIVE_CURRENCY[chainId]!;
    if (token.equals(nativeCurrency)) {
      const estimateGasCost = (
        routeWithValidQuote: MixedRouteWithValidQuote
      ): {
        gasEstimate: BigNumber;
        gasCostInToken: CurrencyAmount;
        gasCostInUSD: CurrencyAmount;
      } => {
        const { totalGasCostNativeCurrency, baseGasUse } = this.estimateGas(
          routeWithValidQuote,
          gasPriceWei,
          chainId
        );

        const token0 = usdPool.token0.address == nativeCurrency.address;

        const nativeTokenPrice = token0
          ? usdPool.token0Price
          : usdPool.token1Price;

        const gasCostInTermsOfUSD: CurrencyAmount = nativeTokenPrice.quote(
          totalGasCostNativeCurrency
        ) as CurrencyAmount;

        return {
          gasEstimate: baseGasUse,
          gasCostInToken: totalGasCostNativeCurrency,
          gasCostInUSD: gasCostInTermsOfUSD,
        };
      };

      return {
        estimateGasCost,
      };
    }

    // If the quote token is not in the native currency, we convert the gas cost to be in terms of the quote token.
    // We do this by getting the highest liquidity <quoteToken>/<nativeCurrency> pool. eg. <quoteToken>/ETH pool.
    const nativePool: Pool | null = await this.getHighestLiquidityNativePool(
      chainId,
      token,
      V3poolProvider
    );

    const usdToken =
      usdPool.token0.address == nativeCurrency.address
        ? usdPool.token1
        : usdPool.token0;

    const estimateGasCost = (
      routeWithValidQuote: MixedRouteWithValidQuote
    ): {
      gasEstimate: BigNumber;
      gasCostInToken: CurrencyAmount;
      gasCostInUSD: CurrencyAmount;
    } => {
      const { totalGasCostNativeCurrency, baseGasUse } = this.estimateGas(
        routeWithValidQuote,
        gasPriceWei,
        chainId
      );

      if (!nativePool) {
        log.info(
          `Unable to find ${nativeCurrency.symbol} pool with the quote token, ${token.symbol} to produce gas adjusted costs. Route will not account for gas.`
        );
        return {
          gasEstimate: baseGasUse,
          gasCostInToken: CurrencyAmount.fromRawAmount(token, 0),
          gasCostInUSD: CurrencyAmount.fromRawAmount(usdToken, 0),
        };
      }

      const token0 = nativePool.token0.address == nativeCurrency.address;

      // returns mid price in terms of the native currency (the ratio of quoteToken/nativeToken)
      const nativeTokenPrice = token0
        ? nativePool.token0Price
        : nativePool.token1Price;

      let gasCostInTermsOfQuoteToken: CurrencyAmount;
      try {
        // native token is base currency
        gasCostInTermsOfQuoteToken = nativeTokenPrice.quote(
          totalGasCostNativeCurrency
        ) as CurrencyAmount;
      } catch (err) {
        log.info(
          {
            nativeTokenPriceBase: nativeTokenPrice.baseCurrency,
            nativeTokenPriceQuote: nativeTokenPrice.quoteCurrency,
            gasCostInEth: totalGasCostNativeCurrency.currency,
          },
          'Debug eth price token issue'
        );
        throw err;
      }

      // true if token0 is the native currency
      const token0USDPool = usdPool.token0.address == nativeCurrency.address;

      // gets the mid price of the pool in terms of the native token
      const nativeTokenPriceUSDPool = token0USDPool
        ? usdPool.token0Price
        : usdPool.token1Price;

      let gasCostInTermsOfUSD: CurrencyAmount;
      try {
        gasCostInTermsOfUSD = nativeTokenPriceUSDPool.quote(
          totalGasCostNativeCurrency
        ) as CurrencyAmount;
      } catch (err) {
        log.info(
          {
            usdT1: usdPool.token0.symbol,
            usdT2: usdPool.token1.symbol,
            gasCostInNativeToken: totalGasCostNativeCurrency.currency.symbol,
          },
          'Failed to compute USD gas price'
        );
        throw err;
      }

      return {
        gasEstimate: baseGasUse,
        gasCostInToken: gasCostInTermsOfQuoteToken,
        gasCostInUSD: gasCostInTermsOfUSD!,
      };
    };

    return {
      estimateGasCost: estimateGasCost.bind(this),
    };
  }

  private estimateGas(
    routeWithValidQuote: MixedRouteWithValidQuote,
    gasPriceWei: BigNumber,
    chainId: ChainId
  ) {
    const totalInitializedTicksCrossed = BigNumber.from(
      Math.max(1, _.sum(routeWithValidQuote.initializedTicksCrossedList))
    );
    /**
     * Since we must make a separate call to multicall for each v3 and v2 section, we will have to
     * add the BASE_SWAP_COST to each section.
     */
    let baseGasUse = BigNumber.from(0);

    const route = routeWithValidQuote.route;
    let acc = [];
    let j = 0;
    while (j < route.pools.length) {
      // seek forward until finding a pool of different type
      let section = [];
      if (route.pools[j] instanceof Pool) {
        while (route.pools[j] instanceof Pool) {
          section.push(route.pools[j]);
          j++;
          if (j === route.pools.length) {
            // we've reached the end of the route
            break;
          }
        }
        acc.push(section);
        /// we just added a complete v3 section
        baseGasUse = baseGasUse.add(BASE_SWAP_COST(chainId));
        baseGasUse = baseGasUse.add(COST_PER_HOP(chainId).mul(section.length));
      } else {
        while (route.pools[j] instanceof Pair) {
          section.push(route.pools[j]);
          j++;
          if (j === route.pools.length) {
            // we've reached the end of the route
            break;
          }
        }
        acc.push(section);
        /// we just added a complete v2 section
        baseGasUse = baseGasUse.add(BASE_SWAP_COST_V2);
        baseGasUse = baseGasUse.add(
          /// same behavior in v2 heuristic gas model factory
          COST_PER_EXTRA_HOP_V2.mul(section.length - 1)
        );
      }
    }

    const tickGasUse = COST_PER_INIT_TICK(chainId).mul(
      totalInitializedTicksCrossed
    );
    const uninitializedTickGasUse = COST_PER_UNINIT_TICK.mul(0);

    // base estimate gas used based on chainId estimates for hops and ticks gas useage
    baseGasUse = baseGasUse.add(tickGasUse).add(uninitializedTickGasUse);

    const baseGasCostWei = gasPriceWei.mul(baseGasUse);

    const wrappedCurrency = WRAPPED_NATIVE_CURRENCY[chainId]!;

    const totalGasCostNativeCurrency = CurrencyAmount.fromRawAmount(
      wrappedCurrency,
      baseGasCostWei.toString()
    );

    return {
      totalGasCostNativeCurrency,
      totalInitializedTicksCrossed,
      baseGasUse,
    };
  }

  private async getHighestLiquidityNativePool(
    chainId: ChainId,
    token: Token,
    V3poolProvider: IV3PoolProvider
  ): Promise<Pool | null> {
    const nativeCurrency = WRAPPED_NATIVE_CURRENCY[chainId]!;

    const nativePools = _([FeeAmount.HIGH, FeeAmount.MEDIUM, FeeAmount.LOW])
      .map<[Token, Token, FeeAmount]>((feeAmount) => {
        return [nativeCurrency, token, feeAmount];
      })
      .value();

    const poolAccessor = await V3poolProvider.getPools(nativePools);

    const pools = _([FeeAmount.HIGH, FeeAmount.MEDIUM, FeeAmount.LOW])
      .map((feeAmount) => {
        return poolAccessor.getPool(nativeCurrency, token, feeAmount);
      })
      .compact()
      .value();

    if (pools.length == 0) {
      log.error(
        { pools },
        `Could not find a ${nativeCurrency.symbol} pool with ${token.symbol} for computing gas costs.`
      );

      return null;
    }

    const maxPool = _.maxBy(pools, (pool) => pool.liquidity) as Pool;

    return maxPool;
  }

  private async getHighestLiquidityUSDPool(
    chainId: ChainId,
    V3poolProvider: IV3PoolProvider
  ): Promise<Pool> {
    const usdTokens = usdGasTokensByChain[chainId];
    const wrappedCurrency = WRAPPED_NATIVE_CURRENCY[chainId]!;

    if (!usdTokens) {
      throw new Error(
        `Could not find a USD token for computing gas costs on ${chainId}`
      );
    }

    const usdPools = _([
      FeeAmount.HIGH,
      FeeAmount.MEDIUM,
      FeeAmount.LOW,
      FeeAmount.LOWEST,
    ])
      .flatMap((feeAmount) => {
        return _.map<Token, [Token, Token, FeeAmount]>(
          usdTokens,
          (usdToken) => [wrappedCurrency, usdToken, feeAmount]
        );
      })
      .value();

    const poolAccessor = await V3poolProvider.getPools(usdPools);

    const pools = _([
      FeeAmount.HIGH,
      FeeAmount.MEDIUM,
      FeeAmount.LOW,
      FeeAmount.LOWEST,
    ])
      .flatMap((feeAmount) => {
        const pools = [];

        for (const usdToken of usdTokens) {
          const pool = poolAccessor.getPool(
            wrappedCurrency,
            usdToken,
            feeAmount
          );
          if (pool) {
            pools.push(pool);
          }
        }

        return pools;
      })
      .compact()
      .value();

    if (pools.length == 0) {
      log.error(
        { pools },
        `Could not find a USD/${wrappedCurrency.symbol} pool for computing gas costs.`
      );
      throw new Error(
        `Can't find USD/${wrappedCurrency.symbol} pool for computing gas costs.`
      );
    }

    const maxPool = _.maxBy(pools, (pool) => pool.liquidity) as Pool;

    return maxPool;
  }
}