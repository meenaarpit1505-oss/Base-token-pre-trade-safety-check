// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title TokenSafetySimulator
/// @notice Measurement harness used only as an eth_call code override. It is never deployed.
///         It buys `token` with `quote` and sells it back on one pool, returning the
///         quoted and actual amounts so the API can separate AMM fees from transfer tax
///         and detect a revert on the sell.
contract TokenSafetySimulator {
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    address private cRouter;
    address private cPool;
    address private cFactory;
    address private cQuote;
    address private cToken;
    bool private cStable;
    bool private cQuoteIsWeth;
    uint16 private cFeeBps;
    uint8 private cKind;

    uint256 private oQuotedBuy;
    uint256 private oTokensBought;
    uint256 private oQuotedSell;
    uint256 private oQuoteOut;
    uint256 private oAmountIn;
    uint8 private oPath;

    address private callbackPool;
    uint256 private paySpent;
    uint256 private payRequested;

    /// @param kind 1 = UniswapV2-style router, 2 = Aerodrome router, 3 = concentrated liquidity (Uniswap V3 / Slipstream).
    function run(
        uint8 kind,
        address router,
        address pool,
        address factory,
        address quote,
        address token,
        uint256 amountIn,
        bool stable,
        bool quoteIsWeth,
        uint16 feeBps
    )
        external
        returns (
            bool buyOk,
            bool sellOk,
            uint8 path,
            uint256 amountInUsed,
            uint256 quotedBuy,
            uint256 tokensBought,
            uint256 quotedSell,
            uint256 quoteOut
        )
    {
        require(quote != token && quote != address(0) && token != address(0) && pool != address(0), "args");
        require(amountIn > 0, "amount");

        cKind = kind;
        cRouter = router;
        cPool = pool;
        cFactory = factory;
        cQuote = quote;
        cToken = token;
        cStable = stable;
        cQuoteIsWeth = quoteIsWeth;
        cFeeBps = feeBps;

        if (kind == 3 && quoteIsWeth) {
            uint256 ethBal = address(this).balance;
            if (ethBal > 0) IWETH(quote).deposit{value: ethBal}();
        }

        uint256 amt = amountIn;
        for (uint256 i; i < 3 && amt > 0; i++) {
            if (_attemptBuy(kind, amt)) break;
            amt = amt / 5;
        }

        if (oTokensBought == 0) {
            return (false, false, 0, 0, oQuotedBuy, 0, 0, 0);
        }

        _fillQuotedSell(oTokensBought);
        bool sold = _attemptSell(kind);
        if (!sold && oPath == 1) {
            // Router buy worked but the router sell reverted. Try paying the pool directly.
            sold = _attemptDirectSell(kind);
            if (sold) oPath = 2;
        }

        return (true, sold, oPath, oAmountIn, oQuotedBuy, oTokensBought, oQuotedSell, oQuoteOut);
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    receive() external payable {}

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _paySwap(amount0Delta, amount1Delta);
    }

    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _paySwap(amount0Delta, amount1Delta);
    }

    function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _paySwap(amount0Delta, amount1Delta);
    }

    // --- buy -----------------------------------------------------------------

    function _attemptBuy(uint8 kind, uint256 amt) internal returns (bool) {
        if (kind == 3) {
            if (_buyCl(amt)) {
                oPath = 3;
                return true;
            }
            return false;
        }
        if (kind == 2) {
            if (_buyAeroRouter(amt)) {
                oPath = 1;
                return true;
            }
            if (_buyAeroDirect(amt)) {
                oPath = 2;
                return true;
            }
            return false;
        }
        if (_buyUniRouter(amt)) {
            oPath = 1;
            return true;
        }
        if (_buyUniDirect(amt)) {
            oPath = 2;
            return true;
        }
        return false;
    }

    function _buyUniRouter(uint256 amt) internal returns (bool) {
        address[] memory path = new address[](2);
        path[0] = cQuote;
        path[1] = cToken;
        uint256 quoted;
        try IUniRouter(cRouter).getAmountsOut(amt, path) returns (uint256[] memory amounts) {
            if (amounts.length > 1) quoted = amounts[1];
        } catch {}

        uint256 beforeTokens = _bal(cToken, address(this));
        uint256 beforeQuote = _quoteBal();
        if (cQuoteIsWeth) {
            try IUniRouter(cRouter).swapExactETHForTokensSupportingFeeOnTransferTokens{value: amt}(
                0, path, address(this), block.timestamp + 120
            ) {} catch {
                return false;
            }
        } else {
            if (!_approve(cQuote, cRouter, amt)) return false;
            try IUniRouter(cRouter).swapExactTokensForTokensSupportingFeeOnTransferTokens(
                amt, 0, path, address(this), block.timestamp + 120
            ) {} catch {
                return false;
            }
        }
        return _recordBuy(quoted, beforeTokens, beforeQuote);
    }

    function _buyAeroRouter(uint256 amt) internal returns (bool) {
        IAeroRouter.Route[] memory routes = new IAeroRouter.Route[](1);
        routes[0] = IAeroRouter.Route({from: cQuote, to: cToken, stable: cStable, factory: cFactory});
        uint256 quoted;
        try IAeroRouter(cRouter).getAmountsOut(amt, routes) returns (uint256[] memory amounts) {
            if (amounts.length > 1) quoted = amounts[amounts.length - 1];
        } catch {}

        uint256 beforeTokens = _bal(cToken, address(this));
        uint256 beforeQuote = _quoteBal();
        if (cQuoteIsWeth) {
            try IAeroRouter(cRouter).swapExactETHForTokensSupportingFeeOnTransferTokens{value: amt}(
                0, routes, address(this), block.timestamp + 120
            ) {} catch {
                return false;
            }
        } else {
            if (!_approve(cQuote, cRouter, amt)) return false;
            try IAeroRouter(cRouter).swapExactTokensForTokensSupportingFeeOnTransferTokens(
                amt, 0, routes, address(this), block.timestamp + 120
            ) {} catch {
                return false;
            }
        }
        return _recordBuy(quoted, beforeTokens, beforeQuote);
    }

    function _buyUniDirect(uint256 amt) internal returns (bool) {
        if (cQuoteIsWeth && address(this).balance >= amt) {
            IWETH(cQuote).deposit{value: amt}();
        }
        uint16[4] memory fees;
        fees[0] = cFeeBps == 0 ? 30 : cFeeBps;
        fees[1] = 30;
        fees[2] = 25;
        fees[3] = 100;
        for (uint256 i; i < fees.length; i++) {
            if (fees[i] == 0) continue;
            bool dup;
            for (uint256 j; j < i; j++) {
                if (fees[j] == fees[i]) dup = true;
            }
            if (dup) continue;
            try this.directUniBuy(amt, fees[i]) returns (uint256 quoted, uint256 bought) {
                if (bought == 0) continue;
                oQuotedBuy = quoted;
                oTokensBought = bought;
                oAmountIn = amt;
                return true;
            } catch {}
        }
        return false;
    }

    function directUniBuy(uint256 amt, uint16 feeBps) external returns (uint256 quoted, uint256 bought) {
        require(msg.sender == address(this), "self");
        (uint256 reserveIn, uint256 reserveOut) = _reserves(cQuote);
        quoted = _amountOut(amt, reserveIn, reserveOut, feeBps);
        require(_tryTransfer(cQuote, cPool, amt), "xfer");
        uint256 before = _bal(cToken, address(this));
        _pairSwap(cPool, cToken, quoted, address(this));
        bought = _bal(cToken, address(this)) - before;
        require(bought > 0, "zero");
    }

    function _buyAeroDirect(uint256 amt) internal returns (bool) {
        if (cQuoteIsWeth && address(this).balance >= amt) {
            IWETH(cQuote).deposit{value: amt}();
        }
        try this.directAeroBuy(amt) returns (uint256 quoted, uint256 bought) {
            if (bought == 0) return false;
            oQuotedBuy = quoted;
            oTokensBought = bought;
            oAmountIn = amt;
            return true;
        } catch {
            return false;
        }
    }

    function directAeroBuy(uint256 amt) external returns (uint256 quoted, uint256 bought) {
        require(msg.sender == address(this), "self");
        quoted = IAeroPool(cPool).getAmountOut(amt, cQuote);
        require(_tryTransfer(cQuote, cPool, amt), "xfer");
        uint256 before = _bal(cToken, address(this));
        _pairSwap(cPool, cToken, quoted, address(this));
        bought = _bal(cToken, address(this)) - before;
        require(bought > 0, "zero");
    }

    function _buyCl(uint256 amt) internal returns (bool) {
        address token0 = ICLPool(cPool).token0();
        bool zeroForOne = cQuote == token0;
        if (!zeroForOne && cToken != token0) return false;

        uint256 beforeTokens = _bal(cToken, address(this));
        uint256 beforeQuote = _quoteBal();
        callbackPool = cPool;
        paySpent = 0;
        payRequested = 0;
        try ICLPool(cPool).swap(
            address(this),
            zeroForOne,
            int256(amt),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            ""
        ) returns (int256 amount0, int256 amount1) {
            callbackPool = address(0);
            int256 outDelta = zeroForOne ? amount1 : amount0;
            if (outDelta >= 0) return false;
            uint256 grossOut = uint256(-outDelta);
            return _recordBuy(grossOut, beforeTokens, beforeQuote);
        } catch {
            callbackPool = address(0);
            return false;
        }
    }

    function _recordBuy(uint256 quoted, uint256 beforeTokens, uint256 beforeQuote) internal returns (bool) {
        uint256 afterTokens = _bal(cToken, address(this));
        if (afterTokens <= beforeTokens) return false;
        uint256 afterQuote = _quoteBal();
        oQuotedBuy = quoted;
        oTokensBought = afterTokens - beforeTokens;
        oAmountIn = beforeQuote > afterQuote ? beforeQuote - afterQuote : 0;
        return true;
    }

    // --- sell ----------------------------------------------------------------

    function _fillQuotedSell(uint256 tokens) internal {
        if (cKind == 3) return;
        if (cKind == 2) {
            IAeroRouter.Route[] memory routes = new IAeroRouter.Route[](1);
            routes[0] = IAeroRouter.Route({from: cToken, to: cQuote, stable: cStable, factory: cFactory});
            try IAeroRouter(cRouter).getAmountsOut(tokens, routes) returns (uint256[] memory amounts) {
                if (amounts.length > 1) oQuotedSell = amounts[amounts.length - 1];
            } catch {}
            if (oQuotedSell == 0) {
                try IAeroPool(cPool).getAmountOut(tokens, cToken) returns (uint256 q) {
                    oQuotedSell = q;
                } catch {}
            }
            return;
        }
        address[] memory path = new address[](2);
        path[0] = cToken;
        path[1] = cQuote;
        try IUniRouter(cRouter).getAmountsOut(tokens, path) returns (uint256[] memory amounts) {
            if (amounts.length > 1) oQuotedSell = amounts[1];
        } catch {}
        if (oQuotedSell == 0) {
            (uint256 reserveIn, uint256 reserveOut) = _reserves(cToken);
            oQuotedSell = _amountOut(tokens, reserveIn, reserveOut, cFeeBps == 0 ? 30 : cFeeBps);
        }
    }

    function _attemptSell(uint8 kind) internal returns (bool) {
        uint256 before = _quoteBal();
        bool ok;
        if (kind == 3) {
            ok = _sellCl();
        } else if (kind == 2) {
            ok = oPath == 1 ? _sellAeroRouter() : _sellAeroDirect();
        } else {
            ok = oPath == 1 ? _sellUniRouter() : _sellUniDirect();
        }
        uint256 afterBal = _quoteBal();
        if (afterBal > before) oQuoteOut = afterBal - before;
        if (kind == 3 && ok && payRequested > 0 && paySpent > payRequested && oQuoteOut > 0) {
            // Pool asked for `requested` tokens; transfer tax made us spend more.
            oQuotedSell = oQuoteOut * paySpent / payRequested;
        } else if (kind == 3 && ok && oQuotedSell == 0) {
            oQuotedSell = oQuoteOut;
        }
        return ok && oQuoteOut > 0;
    }

    function _attemptDirectSell(uint8 kind) internal returns (bool) {
        uint256 before = _quoteBal();
        bool ok = kind == 2 ? _sellAeroDirect() : _sellUniDirect();
        uint256 afterBal = _quoteBal();
        if (afterBal > before) oQuoteOut = afterBal - before;
        return ok && oQuoteOut > 0;
    }

    function _sellUniRouter() internal returns (bool) {
        uint256 amount = _bal(cToken, address(this));
        if (amount == 0) return false;
        if (!_approve(cToken, cRouter, amount)) return false;
        address[] memory path = new address[](2);
        path[0] = cToken;
        path[1] = cQuote;
        if (cQuoteIsWeth) {
            try IUniRouter(cRouter).swapExactTokensForETHSupportingFeeOnTransferTokens(
                amount, 0, path, address(this), block.timestamp + 120
            ) {
                return true;
            } catch {
                return false;
            }
        }
        try IUniRouter(cRouter).swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amount, 0, path, address(this), block.timestamp + 120
        ) {
            return true;
        } catch {
            return false;
        }
    }

    function _sellAeroRouter() internal returns (bool) {
        uint256 amount = _bal(cToken, address(this));
        if (amount == 0) return false;
        if (!_approve(cToken, cRouter, amount)) return false;
        IAeroRouter.Route[] memory routes = new IAeroRouter.Route[](1);
        routes[0] = IAeroRouter.Route({from: cToken, to: cQuote, stable: cStable, factory: cFactory});
        if (cQuoteIsWeth) {
            try IAeroRouter(cRouter).swapExactTokensForETHSupportingFeeOnTransferTokens(
                amount, 0, routes, address(this), block.timestamp + 120
            ) {
                return true;
            } catch {
                return false;
            }
        }
        try IAeroRouter(cRouter).swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amount, 0, routes, address(this), block.timestamp + 120
        ) {
            return true;
        } catch {
            return false;
        }
    }

    function _sellUniDirect() internal returns (bool) {
        uint16[4] memory fees;
        fees[0] = cFeeBps == 0 ? 30 : cFeeBps;
        fees[1] = 30;
        fees[2] = 25;
        fees[3] = 100;
        for (uint256 i; i < fees.length; i++) {
            if (fees[i] == 0) continue;
            bool dup;
            for (uint256 j; j < i; j++) {
                if (fees[j] == fees[i]) dup = true;
            }
            if (dup) continue;
            try this.directUniSell(fees[i]) {
                return true;
            } catch {}
        }
        return false;
    }

    function directUniSell(uint16 feeBps) external {
        require(msg.sender == address(this), "self");
        uint256 tokens = _bal(cToken, address(this));
        require(tokens > 0, "bal");
        uint256 poolBefore = _bal(cToken, cPool);
        require(_tryTransfer(cToken, cPool, tokens), "xfer");
        uint256 got = _bal(cToken, cPool) - poolBefore;
        (uint256 reserveIn, uint256 reserveOut) = _reserves(cToken);
        // Reserves do not yet include `got`. If transfer tax reduced `got`, size the swap off what arrived.
        uint256 out = _amountOut(got, reserveIn, reserveOut, feeBps);
        require(out > 0, "out");
        _pairSwap(cPool, cQuote, out, address(this));
    }

    function _sellAeroDirect() internal returns (bool) {
        try this.directAeroSell() {
            return true;
        } catch {
            return false;
        }
    }

    function directAeroSell() external {
        require(msg.sender == address(this), "self");
        uint256 tokens = _bal(cToken, address(this));
        require(tokens > 0, "bal");
        uint256 poolBefore = _bal(cToken, cPool);
        require(_tryTransfer(cToken, cPool, tokens), "xfer");
        uint256 got = _bal(cToken, cPool) - poolBefore;
        uint256 out = IAeroPool(cPool).getAmountOut(got, cToken);
        require(out > 0, "out");
        _pairSwap(cPool, cQuote, out, address(this));
    }

    function _sellCl() internal returns (bool) {
        uint256 amount = _bal(cToken, address(this));
        if (amount == 0) return false;
        address token0 = ICLPool(cPool).token0();
        bool zeroForOne = cToken == token0;
        callbackPool = cPool;
        paySpent = 0;
        payRequested = 0;
        try ICLPool(cPool).swap(
            address(this),
            zeroForOne,
            int256(amount),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            ""
        ) returns (int256 amount0, int256 amount1) {
            callbackPool = address(0);
            int256 outDelta = zeroForOne ? amount1 : amount0;
            if (outDelta >= 0) return false;
            if (oQuotedSell == 0) oQuotedSell = uint256(-outDelta);
            return true;
        } catch {
            callbackPool = address(0);
            return false;
        }
    }

    function _paySwap(int256 amount0Delta, int256 amount1Delta) internal {
        require(msg.sender == callbackPool, "pool");
        if (amount0Delta > 0) {
            _payToken(ICLPool(msg.sender).token0(), uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            _payToken(ICLPool(msg.sender).token1(), uint256(amount1Delta));
        }
    }

    function _payToken(address token, uint256 requested) internal {
        uint256 before = _bal(token, address(this));
        require(_tryTransfer(token, msg.sender, requested), "pay");
        uint256 spent = before - _bal(token, address(this));
        if (token == cToken) {
            paySpent = spent;
            payRequested = requested;
        }
    }

    // --- math / token helpers ------------------------------------------------

    function _quoteBal() internal view returns (uint256) {
        uint256 erc20 = _bal(cQuote, address(this));
        if (cQuoteIsWeth) return erc20 + address(this).balance;
        return erc20;
    }

    function _reserves(address tokenIn) internal view returns (uint256 reserveIn, uint256 reserveOut) {
        (uint256 r0, uint256 r1,) = IPair(cPool).getReserves();
        address t0 = IPair(cPool).token0();
        if (tokenIn == t0) return (r0, r1);
        return (r1, r0);
    }

    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint16 feeBps)
        internal
        pure
        returns (uint256)
    {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0 || feeBps >= 10000) return 0;
        uint256 amountInWithFee = amountIn * (10000 - feeBps);
        return (amountInWithFee * reserveOut) / (reserveIn * 10000 + amountInWithFee);
    }

    function _pairSwap(address pair, address tokenOut, uint256 amountOut, address to) internal {
        address t0 = IPair(pair).token0();
        if (tokenOut == t0) IPair(pair).swap(amountOut, 0, to, "");
        else IPair(pair).swap(0, amountOut, to, "");
    }

    function _bal(address token, address who) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, who));
        if (!ok || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }

    function _tryTransfer(address token, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok) return false;
        if (data.length == 0) return true;
        if (data.length < 32) return false;
        return abi.decode(data, (bool));
    }

    function _approve(address token, address spender, uint256 amount) internal returns (bool) {
        // Some tokens (USDT-style) require a zero reset before a new allowance.
        token.call(abi.encodeWithSelector(0x095ea7b3, spender, 0));
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!ok) return false;
        if (data.length == 0) return true;
        if (data.length < 32) return false;
        return abi.decode(data, (bool));
    }
}

interface IWETH {
    function deposit() external payable;
    function balanceOf(address) external view returns (uint256);
}

interface IPair {
    function getReserves() external view returns (uint256, uint256, uint256);
    function token0() external view returns (address);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IAeroPool {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
    function getReserves() external view returns (uint256, uint256, uint256);
    function token0() external view returns (address);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IUniRouter {
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

interface IAeroRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function getAmountsOut(uint256 amountIn, Route[] calldata routes) external view returns (uint256[] memory);
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external;
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external;
}

interface ICLPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}
