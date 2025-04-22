// funding_strategy_long_v4_direct_fetch.js

// เพิ่ม console.log แรกสุดเพื่อเช็คว่าสคริปต์เริ่มทำงานไหม
console.log("Script Starting...");

require('dotenv').config();
const Binance = require('node-binance-api');
const Table = require('cli-table3');
const chalk = require('chalk');
const axios = require('axios');
const crypto = require('crypto');

// --- Configuration ---
const USE_TESTNET = false; // ตั้งเป็น true เพื่อใช้ Testnet
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET_KEY = process.env.BINANCE_SECRET_KEY;
const FUTURES_API_BASE = USE_TESTNET ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';

// --- Strategy Parameters ---
const POSITION_SIDE = 'LONG';
const FUNDING_RATE_PREFERENCE = 'NEGATIVE';
const FUNDING_RATE_THRESHOLD = -0.001;
const INVESTMENT_USD = 300;
const LEVERAGE = 10;
const STOP_LOSS_PERCENT = 0.007;
const ENTRY_SECONDS_BEFORE_FUNDING = 10; // *** ใช้ 10 วินาที ***
const CHECK_INTERVAL_MS = 10000; // 10 วินาที
const TOP_LIST_COUNT = 10;
const MAKER_FEE = 0.0002;
const TAKER_FEE = 0.0005;
const EXECUTE_TRADES = true; // *** ตั้งเป็น false เพื่อทดสอบก่อนเสมอ! ***
const IGNORE_COUNTDOWN = false;
const VERIFY_SYMBOLS = true;

// --- Exit Strategy Configuration ---
const EXIT_STRATEGY = 'PostFundingProfitCheck';
const PROFIT_CHECK_DELAY_SECONDS = 10;

// --- State Variables ---
let currentPosition = null;
let tradeHistory = [];
let exchangeInfo = null;
let isPlacingOrder = false;
let tradableSymbols = new Set();
let verifiedSymbols = new Set();
let lastDataFetchTime = null;

// --- Binance API Initialization ---
// ทำหลังประกาศตัวแปร Config ทั้งหมด
let binance = null;
try {
    binance = new Binance().options({
        APIKEY: BINANCE_API_KEY,
        APISECRET: BINANCE_SECRET_KEY,
        recvWindow: 60000,
        urls: {
            base: `${FUTURES_API_BASE}/fapi/v1/`,
            wapi: `${FUTURES_API_BASE}/fapi/v1/`,
            stream: USE_TESTNET ? 'wss://stream.binancefuture.com/stream' : 'wss://fstream.binance.com/stream',
            margin: `${FUTURES_API_BASE}/fapi/v1/`,
            futures: `${FUTURES_API_BASE}/fapi/v1/`
        },
        family: 4,
        test: USE_TESTNET,
        futures: true
    });
    console.log("Binance client initialized.");
} catch (initError) {
    console.error(chalk.red("Error initializing Binance client:"), initError);
    process.exit(1); // ออกจากโปรแกรมถ้า client สร้างไม่ได้
}


// --- Helper Functions ---
function getSymbolPrecision(symbol) {
    if (!exchangeInfo) { console.warn("Exchange info missing for precision check."); return null; }
    const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === symbol && s.contractType === 'PERPETUAL');
    if (!symbolInfo) { /* console.warn(`Precision not found for ${symbol}`); */ return null; }
    try {
        return {
            symbol: symbol,
            pricePrecision: symbolInfo.pricePrecision,
            quantityPrecision: symbolInfo.quantityPrecision,
            minQty: parseFloat(symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE').minQty),
            tickSize: parseFloat(symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER').tickSize)
        };
    } catch (e) { console.error(chalk.red(`Error parsing precision for ${symbol}:`), e); return null; }
}

function formatQuantity(quantity, precision) {
    if (precision === null || precision === undefined || isNaN(quantity)) return quantity;
    const factor = Math.pow(10, precision);
    return Math.floor(quantity * factor) / factor;
}

function formatPrice(price, precision) {
    if (precision === null || precision === undefined || isNaN(price)) return price;
    return parseFloat(price.toFixed(precision));
}

function adjustPriceToTickSize(price, tickSize) {
    if (!tickSize || isNaN(price) || isNaN(tickSize) || tickSize <= 0) return price;
    const factor = 1 / tickSize;
    return Math.round(price * factor) / factor;
}

function formatCountdown(ms) {
    if (isNaN(ms)) return "Invalid Time";
    if (ms <= 0) return chalk.gray("Passed");
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}


function calculateTradeMetrics(entryPrice, symbolPrecision, fundingRate) {
    if (!symbolPrecision || !entryPrice || entryPrice <= 0 || fundingRate === undefined || fundingRate >= 0) return null;
    const positionValue = INVESTMENT_USD * LEVERAGE;
    let quantity = positionValue / entryPrice;
    const formattedQuantity = formatQuantity(quantity, symbolPrecision.quantityPrecision);
    if (!formattedQuantity || formattedQuantity < symbolPrecision.minQty) return null;
    const entryFee = positionValue * TAKER_FEE;
    const slPriceRaw = entryPrice * (1 - STOP_LOSS_PERCENT);
    const slPriceAdjusted = adjustPriceToTickSize(slPriceRaw, symbolPrecision.tickSize);
    const formattedSlPrice = formatPrice(slPriceAdjusted, symbolPrecision.pricePrecision);
    if (formattedSlPrice >= entryPrice) return null;
    const estimatedFundingFeeGain = -positionValue * fundingRate;
    const potentialLossUSD = positionValue * STOP_LOSS_PERCENT;
    const exitFeeSL = (positionValue * (1 - STOP_LOSS_PERCENT)) * TAKER_FEE;
    const netLossAtSL = potentialLossUSD + entryFee + exitFeeSL;
    return { positionValue: positionValue.toFixed(2), quantity: formattedQuantity, entryFee: entryFee.toFixed(5),
             tpPrice: null, slPrice: formattedSlPrice, netProfitAtTP: null, netLossAtSL: netLossAtSL.toFixed(4),
             estimatedFundingFeeGainOrLoss: estimatedFundingFeeGain.toFixed(5) };
}

function displayTopCandidates(candidates) {
    console.log(chalk.blueBright(`\n--- Top ${candidates.length} NEGATIVE Rate Candidates (Sorted by Time, then Rate) ---`));
    const updateTimeMsg = lastDataFetchTime ? `Last data update: ${new Date(lastDataFetchTime).toLocaleTimeString()}` : 'Data not yet updated';
    console.log(chalk.cyan(updateTimeMsg));

    const table = new Table({
        head: [ chalk.cyan('Rank'), chalk.cyan('Symbol'), chalk.cyan('Funding (%)'), chalk.cyan('Countdown'),
                chalk.cyan('Est. Qty'), chalk.cyan('SL Price'), chalk.cyan('Net Loss @SL ($)'), chalk.cyan('Est. Fund Gain ($)') ],
        colWidths: [6, 15, 14, 13, 12, 12, 18, 18], style: { 'padding-left': 1, 'padding-right': 1, head: ['blue'], border: ['grey'] } });

    if (!candidates || candidates.length === 0) { console.log(chalk.yellow("   No candidates meet criteria.")); return; }

    candidates.forEach((c, index) => {
        const metrics = c.metrics; if (!metrics) return;
        const rateColor = chalk.red; const feeStyle = chalk.greenBright;
        table.push([ index + 1, chalk.whiteBright(c.symbol),
                     rateColor(`${(c.fundingRate * 100).toFixed(4)}%`), formatCountdown(c.countdownMs),
                     metrics.quantity, metrics.slPrice, chalk.red(metrics.netLossAtSL), feeStyle(metrics.estimatedFundingFeeGainOrLoss) ]);
    });
    console.log(table.toString());
    console.log(chalk.cyan("Est. Fund Gain ($): Amount you receive"));
}

async function displayCurrentPosition() {
    if (!currentPosition) { console.log(chalk.blue("\n--- No Active Position ---")); return; }
    const side = currentPosition.positionSide; const sideColor = chalk.green; // Always LONG
    console.log(chalk.yellow(`\n--- Current Position (${sideColor(side)}) ---`));
    try {
        const ticker = await binance.futuresMarkPrice(currentPosition.symbol); const markPrice = parseFloat(ticker.markPrice);
        const entryPrice = currentPosition.entryPrice; const quantity = currentPosition.quantity;
        let pnl = (markPrice - entryPrice) * quantity;
        const pricePrecision = getSymbolPrecision(currentPosition.symbol)?.pricePrecision || 2;
        const table = new Table({ head: [ /* ... */ ], style: { /* ... */ } });
        table.push([ currentPosition.symbol, sideColor(side), entryPrice.toFixed(pricePrecision), markPrice.toFixed(pricePrecision), quantity,
                     pnl >= 0 ? chalk.green(pnl.toFixed(4)) : chalk.red(pnl.toFixed(4)), new Date(currentPosition.entryTimestamp).toLocaleTimeString() ]);
        console.log(table.toString()); console.log(`   SL Order ID: ${currentPosition.orderIds?.sl || 'N/A'}`);
        if (currentPosition.profitCheckTimeoutId) { console.log(chalk.cyan(`   Profit Check Pending: Yes`)); }
        else if (EXIT_STRATEGY === 'PostFundingProfitCheck' && !currentPosition.profitCheckCompleted) { console.log(chalk.gray(`   Profit Check Pending: No`)); }
    } catch (error) { console.error(chalk.red(`Error fetching PNL: ${error.body || error.message}`)); /* ... fallback table ... */ }
}

function displayTradeHistory() {
    console.log(chalk.yellow("\n--- Trade History ---"));
    if (tradeHistory.length === 0) { console.log("   No trades recorded yet."); return; }
    const table = new Table({ head: [ /* ... */ chalk.cyan('Side'), /* ... */], style: { /* ... */ } });
    [...tradeHistory].reverse().forEach(trade => {
        const pricePrecision = getSymbolPrecision(trade.symbol)?.pricePrecision || 2; const sideColor = chalk.green;
        table.push([ new Date(trade.closeTimestamp).toLocaleString(), trade.symbol, sideColor(trade.side || 'LONG'),
                     trade.entryPrice.toFixed(pricePrecision), trade.exitPrice.toFixed(pricePrecision), trade.quantity,
                     trade.pnl >= 0 ? chalk.green(trade.pnl.toFixed(4)) : chalk.red(trade.pnl.toFixed(4)), trade.reason ]);
    }); console.log(table.toString());
}


// --- Main Logic ---
async function fetchAndAnalyze() {
    // เพิ่ม Log ตอนเริ่มฟังก์ชัน
    // console.log(chalk.gray(`[${new Date().toLocaleTimeString()}] fetchAndAnalyze cycle start.`));
    if (isPlacingOrder) { scheduleNextCheck(); return; }
    try {
        // console.log(chalk.blue(`[${new Date().toLocaleTimeString()}] --- Starting Fetch Cycle ---`)); // Log เริ่มรอบ (อาจจะถี่ไป)

        // 1. Fetch Data
        // console.log(`Workspaceing all premium index data directly...`);
        const allPremiumData = await directGetAllPremiumIndexData();
        lastDataFetchTime = Date.now();

        if (!allPremiumData || allPremiumData.length === 0) {
            // console.warn(chalk.yellow("Warning: No premium index data received.")); // ลด Log
            scheduleNextCheck(); return;
        }
        // console.log(`Received ${allPremiumData.length} entries.`); // Log จำนวนข้อมูลดิบ

        // 2. Filter & Map
        const nowTimestamp = Date.now();
        let candidatesBeforeMetrics = allPremiumData
            .filter(item => item.symbol.endsWith('USDT') && item.fundingRate < FUNDING_RATE_THRESHOLD);

        // console.log(`Found ${candidatesBeforeMetrics.length} USDT candidates with negative rates.`);

        let candidates = candidatesBeforeMetrics.map(item => {
                const symbol = item.symbol;
                const symbolPrecision = getSymbolPrecision(symbol); if (!symbolPrecision) return null;
                const metrics = calculateTradeMetrics(item.markPrice, symbolPrecision, item.fundingRate); if (!metrics) return null;
                const nextFundingTimestamp = item.nextFundingTime; const countdownMs = nextFundingTimestamp - nowTimestamp;
                return { symbol, fundingRate: item.fundingRate, fundingTime: nextFundingTimestamp, countdownMs,
                         markPrice: item.markPrice, metrics, precision: symbolPrecision };
            }).filter(candidate => candidate !== null);

        // console.log(`Processed ${candidates.length} candidates after metrics calculation.`);

        if (candidates.length === 0) {
             displayTopCandidates([]); // แสดงว่าไม่มี candidate
             scheduleNextCheck(); return;
        }

        // 3. Candidate Selection Logic
        candidates.sort((a, b) => a.fundingRate - b.fundingRate); // Most negative first
        const topNegativeRates = candidates.slice(0, TOP_LIST_COUNT);
        topNegativeRates.sort((a, b) => { if (a.fundingTime !== b.fundingTime) return a.fundingTime - b.fundingTime; return a.fundingRate - b.fundingRate; });
        const finalCandidates = topNegativeRates;
        // console.log(`Selected final ${finalCandidates.length} candidates.`);

        // 4. Display Candidates
        displayTopCandidates(finalCandidates); // แสดง candidate ที่เข้าเงื่อนไข

        // 5. Check for Trading Opportunity
        const topCandidate = finalCandidates.length > 0 ? finalCandidates[0] : null;

        if (topCandidate && !currentPosition && !isPlacingOrder) {
            const timeRemainingMs = topCandidate.countdownMs;
            const entryWindowMs = ENTRY_SECONDS_BEFORE_FUNDING * 1000;
            // console.log(chalk.cyan(`Top candidate: ${topCandidate.symbol} Countdown: ${formatCountdown(timeRemainingMs)}`));

            if (timeRemainingMs > 0 && timeRemainingMs <= entryWindowMs) {
                console.log(chalk.magenta(`>>> Entry window (${formatCountdown(timeRemainingMs)} left). Preparing LONG entry for ${topCandidate.symbol}...`));
                await placeTrade(topCandidate);
            }
        } else if (currentPosition) {
            await checkPositionStatus();
        }

        // Display status sections
        if (!currentPosition || !isPlacingOrder) {
           await displayCurrentPosition();
           displayTradeHistory();
        }
    } catch (error) {
        console.error(chalk.red(`Error in fetchAndAnalyze loop:`), error.body || error.msg || error.message || error);
    } finally {
        scheduleNextCheck();
    }
}

function scheduleNextCheck() { setTimeout(fetchAndAnalyze, CHECK_INTERVAL_MS); }

// --- Trade Execution ---
async function placeTrade(candidate) {
    if (isPlacingOrder) { console.warn(chalk.yellow("Aborting: Placement in progress.")); return; }
    isPlacingOrder = true;

    const symbol = candidate.symbol; const metrics = candidate.metrics;
    if (!metrics || !metrics.slPrice) { console.error(chalk.red(`Metrics/SL missing for ${symbol}`)); isPlacingOrder = false; return; }
    const quantity = metrics.quantity; const slPrice = metrics.slPrice;
    const fundingTimestamp = candidate.fundingTime; const fundingRate = candidate.fundingRate;
    const entryFee = parseFloat(metrics.entryFee); const side = 'LONG';

    console.log(chalk.blue(`\n=== Attempting ${side} Entry for ${symbol} (${EXIT_STRATEGY} Strategy) ===`));
    console.log(`   Lev: ${LEVERAGE}x, Qty: ${quantity}, SL: ${slPrice}`);
    console.log(`   Fund Rate: ${(fundingRate * 100).toFixed(4)}%, Est. Gain: ${metrics.estimatedFundingFeeGainOrLoss} USD`);

    if (!EXECUTE_TRADES) { console.log(chalk.yellow(`   SIMULATION MODE.`)); isPlacingOrder = false; return; }
    if (!tradableSymbols.has(symbol) && VERIFY_SYMBOLS && !verifiedSymbols.has(symbol)) { console.error(chalk.red(`${symbol} not tradable.`)); isPlacingOrder = false; return; }

    let slOrder = null; let tempPositionData = null;

    try {
        console.log(`   1. Setting leverage...`); await directSetLeverage(symbol, LEVERAGE); console.log(chalk.green(`OK`));
        console.log(`   2. Placing MARKET BUY...`);
        const entryOrder = await binance.futuresMarketBuy(symbol, quantity, { newOrderRespType: 'RESULT' });
        console.log(chalk.green(`OK ID: ${entryOrder.orderId}`));

        const executedQty = parseFloat(entryOrder.executedQty) || quantity; let entryPrice = parseFloat(entryOrder.avgPrice);
        if (!entryPrice || entryPrice <= 0) { const ticker = await binance.futuresMarkPrice(symbol); entryPrice = parseFloat(ticker.markPrice); }
        if (!entryPrice || entryPrice <= 0) throw new Error("Invalid entry price.");
        const entryTimestamp = entryOrder.updateTime || Date.now();
        console.log(`      Entry Price: ${entryPrice.toFixed(candidate.precision.pricePrecision)}`);

        tempPositionData = { symbol, entryPrice, quantity: executedQty, positionAmt: executedQty, entryTimestamp,
                             orderIds: { sl: null }, positionSide: side, fundingRate, entryFee,
                             profitCheckTimeoutId: null, profitCheckCompleted: false };

        console.log(`   3. Placing SL @ ${slPrice}...`);
        slOrder = await directPlaceLongSLOrder(symbol, executedQty, slPrice);
        tempPositionData.orderIds.sl = slOrder.orderId;
        console.log(chalk.green(`OK ID: ${slOrder.orderId}`));

        currentPosition = tempPositionData; // Commit state
        console.log(chalk.green(`   Position Opened: ${side} ${symbol}`));

        // Schedule Profit Check
        const checkTargetTimestamp = fundingTimestamp + (PROFIT_CHECK_DELAY_SECONDS * 1000);
        const checkDelayMs = checkTargetTimestamp - Date.now();
        const displayCheckTime = new Date(checkTargetTimestamp).toLocaleTimeString();

        if (checkDelayMs > 0) {
            console.log(`   4. Scheduling Profit Check (${formatCountdown(checkDelayMs)} at ${displayCheckTime})...`);
            const checkParams = { symbol, quantity: executedQty, entryPrice, fundingRate, entryFee, side, slOrderId: slOrder.orderId };
            const timeoutId = setTimeout(async () => {
                if (currentPosition?.symbol === checkParams.symbol && currentPosition.orderIds?.sl === checkParams.slOrderId) {
                    await checkProfitAndCloseOrHold(checkParams);
                }
            }, checkDelayMs);
            if(currentPosition) currentPosition.profitCheckTimeoutId = timeoutId; // Store ID only if position still valid
            console.log(chalk.green(`      Scheduled.`));
        } else { console.warn(chalk.yellow(`   4. Target profit check time passed. Not scheduled.`)); }

        console.log(chalk.blue(`=== Placement Finished for ${symbol} ===`));
    } catch (error) {
        console.error(chalk.red(`\n--- Placement Error for ${symbol}: ---`), error.code, error.msg);
        if (tempPositionData && (!slOrder || error)) { await emergencyClosePosition(tempPositionData.symbol, tempPositionData.quantity, tempPositionData.positionSide, "Placement Error"); }
        if (currentPosition?.symbol === candidate.symbol) currentPosition = null;
    } finally { isPlacingOrder = false; }
}

// --- Check Profit Function ---
async function checkProfitAndCloseOrHold(params) {
    const { symbol, quantity, entryPrice, fundingRate, entryFee, side, slOrderId } = params;
    const positionToCheck = currentPosition; if (!positionToCheck || positionToCheck.symbol !== symbol || positionToCheck.orderIds?.sl !== slOrderId) return;
    if (currentPosition && currentPosition.symbol === symbol) { currentPosition.profitCheckTimeoutId = null; currentPosition.profitCheckCompleted = true; }
    console.log(chalk.cyan(`\n[${new Date().toLocaleTimeString()}] Checking profit for ${side} ${symbol}...`));
    if (isPlacingOrder) { console.warn(chalk.yellow(`Profit check deferred: Busy.`)); return; } isPlacingOrder = true;
    try {
        const ticker = await binance.futuresMarkPrice(symbol); const markPrice = parseFloat(ticker.markPrice); if (!markPrice || markPrice <= 0) throw new Error("Invalid mark price.");
        const unrealizedPnl = (markPrice - entryPrice) * quantity; // LONG PNL
        const positionValue = entryPrice * quantity; const fundingGain = -positionValue * fundingRate;
        const exitFee = markPrice * quantity * TAKER_FEE; const netPnl = unrealizedPnl + fundingGain - entryFee - exitFee;
        console.log(`   Calculation: PNL(Price)=${unrealizedPnl.toFixed(4)}, Fund Gain=${fundingGain.toFixed(4)}, Fees=${(entryFee + exitFee).toFixed(4)}`);
        console.log(`   >>> Estimated Net PNL: ${netPnl >= 0 ? chalk.green(netPnl.toFixed(4)) : chalk.red(netPnl.toFixed(4))} USD <<<`);
        if (netPnl > 0) {
            console.log(chalk.greenBright(`   Net PNL POSITIVE. Closing ${symbol}...`)); let slCancelled = false;
            try { console.log(`      Canceling SL ${slOrderId}...`); await binance.futuresCancel(symbol, { orderId: slOrderId }); console.log(chalk.green(`OK`)); slCancelled = true; if(currentPosition?.symbol === symbol) currentPosition.orderIds.sl = null; }
            catch (cancelError) { if (!cancelError.body?.includes('-2011')) console.warn(chalk.yellow(`Warn cancelling SL: ${cancelError.msg}`)); else console.log(chalk.gray(`SL gone.`)); slCancelled = true; if(currentPosition?.symbol === symbol) currentPosition.orderIds.sl = null; }
            if (slCancelled) {
                console.log(`      Placing MARKET SELL (Reduce Only)...`);
                try { const closeOrder = await binance.futuresMarketSell(symbol, quantity, { reduceOnly: true }); console.log(chalk.green(`OK ID: ${closeOrder.orderId}`)); console.log(chalk.greenBright(`   Position ${symbol} closed.`)); if (currentPosition?.symbol === symbol) currentPosition = null; }
                catch (closeError) { console.error(chalk.red(`MARKET SELL FAILED:`), closeError.msg); console.error(chalk.red.bold(`!!! FAILED CLOSE ${symbol}, SL CANCELLED. MANUAL URGENT !!!`));}
            } else { console.error(chalk.red(`Skipping close ${symbol}: SL cancel failed.`)); }
        } else { console.log(chalk.yellow(`   Net PNL not positive. Holding ${symbol} with SL ${slOrderId}.`)); }
    } catch (error) { console.error(chalk.red(`   Error during profit check:`), error.message || error); console.warn(chalk.yellow(`   Holding ${symbol} with SL ${slOrderId}.`)); }
    finally { isPlacingOrder = false; }
}

// --- Emergency Close Function ---
async function emergencyClosePosition(symbol, quantity, side, reason) {
    console.warn(chalk.red.bold(`\n!!! EMERGENCY CLOSE ${side} ${symbol} !!! Reason: ${reason}`));
    if (isPlacingOrder) { console.warn(chalk.yellow("Emergency close deferred: Busy.")); return; } isPlacingOrder = true; let closed = false;
    try {
        const closeSide = side === 'LONG' ? 'SELL' : 'BUY'; console.log(`   Attempting MARKET ${closeSide} (Reduce Only)...`);
        const closeOrder = await (closeSide === 'SELL' ? binance.futuresMarketSell(symbol, quantity, { reduceOnly: true }) : binance.futuresMarketBuy(symbol, quantity, { reduceOnly: true }));
        console.log(chalk.green(`   Emergency Market ${closeSide} OK ID: ${closeOrder.orderId}`)); closed = true;
    } catch (error) { console.error(chalk.red(`Emergency close FAILED:`), error.body || error.msg); }
    finally {
         if (currentPosition?.symbol === symbol) {
             if (currentPosition.orderIds?.sl) await binance.futuresCancel(symbol, { orderId: currentPosition.orderIds.sl }).catch(e => {});
             if (currentPosition.profitCheckTimeoutId) clearTimeout(currentPosition.profitCheckTimeoutId);
             if (closed) currentPosition = null; else console.error(chalk.red.bold(`!!! FAILED EMERGENCY CLOSE ${symbol}. MANUAL INTERVENTION !!!`));
         } isPlacingOrder = false;
     }
}

// --- Check Position Status ---
async function checkPositionStatus() {
     if (!currentPosition || !currentPosition.symbol || isPlacingOrder) return;
     const positionBeforeCheck = { ...currentPosition }; const symbol = positionBeforeCheck.symbol; const slOrderId = positionBeforeCheck.orderIds?.sl;

     try {
         const positionRisk = await binance.futuresPositionRisk({ symbol: symbol }); const pos = positionRisk.find(p => p.symbol === symbol);
         const currentPositionAmt = pos ? parseFloat(pos.positionAmt) : 0;

         if (currentPosition?.symbol === symbol && Math.abs(currentPositionAmt) < (positionBeforeCheck.quantity * 0.01)) {
             console.log(chalk.magenta(`\nPosition ${symbol} (${positionBeforeCheck.positionSide}) closed. Checking history...`));
             if (currentPosition.profitCheckTimeoutId) clearTimeout(currentPosition.profitCheckTimeoutId);

             let closingTrade = null; let reason = 'Unknown/Manual'; let exitPrice = pos?.markPrice || positionBeforeCheck.entryPrice; let realizedPnl = pos?.unRealizedProfit || 0;

             try {
                 const closeSide = 'SELL'; const trades = await binance.futuresUserTrades(symbol, { limit: 10, startTime: positionBeforeCheck.entryTimestamp - 5000 });
                 const closingTrades = trades.filter(t => t.symbol === symbol && t.side === closeSide && Math.abs(parseFloat(t.qty) - positionBeforeCheck.quantity) < (positionBeforeCheck.quantity * 0.005) && t.time >= positionBeforeCheck.entryTimestamp && parseFloat(t.realizedPnl) !== 0).sort((a, b) => b.time - a.time);
                 if (closingTrades.length > 0) {
                     closingTrade = closingTrades[0]; exitPrice = parseFloat(closingTrade.price); realizedPnl = parseFloat(closingTrade.realizedPnl);
                     if (String(closingTrade.orderId) === String(slOrderId)) reason = 'SL Hit';
                     else if (positionBeforeCheck.profitCheckCompleted && !positionBeforeCheck.orderIds?.sl) reason = 'Closed After Profit Check';
                     else reason = `Closed (API/Manual ${closingTrade.orderId})`;
                 } else reason = 'Closed (History Check Failed)';
             } catch (tradeError) { reason = 'History Check Error'; console.error("Error fetching trades:", tradeError.body || tradeError.message); }

             tradeHistory.push({ closeTimestamp: closingTrade?.time || Date.now(), symbol, side: positionBeforeCheck.positionSide, entryPrice: positionBeforeCheck.entryPrice, exitPrice, quantity: positionBeforeCheck.quantity, pnl: realizedPnl, reason });
             console.log(chalk.magenta(`Position ${symbol} processed. Reason: ${reason}. PNL: ${realizedPnl.toFixed(4)}`));
             if (currentPosition?.symbol === symbol) currentPosition = null;
         }
     } catch (error) { console.error(chalk.red(`Error checkPositionStatus ${symbol}:`), error.body || error.message); }
}

// --- Initialization ---
async function initialize() {
    console.log(chalk.bold.blue(`===== Funding Rate Strategy Bot Initializing (${EXIT_STRATEGY} - LONG on Negative Rate) =====`));
    if (!BINANCE_API_KEY || !BINANCE_SECRET_KEY) { console.error(chalk.red.bold("API Keys missing!")); process.exit(1); }
    console.log("API Keys found.");
    try {
        console.log("Fetching Exchange Info..."); exchangeInfo = await binance.futuresExchangeInfo(); if (!exchangeInfo?.symbols) throw new Error("Bad Exchange Info.");
        console.log(chalk.green(`Exchange Info OK (${exchangeInfo.symbols.length} symbols).`));

        console.log("Building tradable symbols list..."); tradableSymbols.clear(); verifiedSymbols.clear();
        exchangeInfo.symbols.forEach(s => { if (s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.symbol.endsWith('USDT')) tradableSymbols.add(s.symbol); });
        console.log(chalk.green(`Found ${tradableSymbols.size} tradable symbols.`));

        if (VERIFY_SYMBOLS) {
            console.log(chalk.cyan("\nVerifying common symbols...")); const commonSymbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT']; let verifiedCount = 0;
            for (const symbol of commonSymbols) { if (tradableSymbols.has(symbol)) { if (await verifySymbol(symbol)) verifiedCount++; else tradableSymbols.delete(symbol); } }
            console.log(chalk.cyan(`Verification complete. ${verifiedCount} common symbols OK.`));
        } else console.log(chalk.yellow("\nSymbol verification skipped."));

        console.log("\nChecking API keys..."); await binance.futuresBalance(); console.log(chalk.green("API keys OK."));

        console.log(chalk.blue("\nStarting analysis loop... Interval:", CHECK_INTERVAL_MS / 1000, "s."));
        console.log(chalk.yellow(`Strategy: ${POSITION_SIDE} on ${FUNDING_RATE_PREFERENCE} Rate, Exit: ${EXIT_STRATEGY}`));
        console.log(chalk.yellow(`Params: Invest=${INVESTMENT_USD}$, Lev=${LEVERAGE}x, SL=${STOP_LOSS_PERCENT*100}%, Entry=${ENTRY_SECONDS_BEFORE_FUNDING}sec, CheckDelay=${PROFIT_CHECK_DELAY_SECONDS}s`)); // ใช้ sec
        if (EXECUTE_TRADES) console.log(chalk.green.bold("Trade Execution: ENABLED")); else console.log(chalk.yellow.bold("Trade Execution: DISABLED (Simulation Mode)"));

        fetchAndAnalyze(); // Start loop

    } catch (error) { console.error(chalk.red.bold("\nInitialization failed:"), error.body || error.msg || error.message || error); process.exit(1); }
}

// --- Symbol Verification ---
async function verifySymbol(symbol) {
    if (verifiedSymbols.has(symbol)) return true;
    try { await binance.futuresMarkPrice(symbol); await directSetLeverage(symbol, LEVERAGE); verifiedSymbols.add(symbol); return true; }
    catch (error) { /* console.log(`Verify failed ${symbol}`); */ return false; }
}


// --- Direct API Call Functions ---
function createSignature(queryString) { return crypto.createHmac('sha256', BINANCE_SECRET_KEY).update(queryString).digest('hex'); }

async function directApiRequest(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now(); let queryString = `timestamp=${timestamp}`;
    Object.keys(params).sort().forEach(key => { if (params[key] !== undefined) queryString += `&${key}=${encodeURIComponent(params[key])}`; });
    const signature = createSignature(queryString); const url = `${FUTURES_API_BASE}${endpoint}?${queryString}&signature=${signature}`;
    try { const response = await axios({ method: method, url: url, headers: { 'X-MBX-APIKEY': BINANCE_API_KEY } }); return response.data; }
    catch (error) { if (error.response?.data?.code !== undefined) throw { code: error.response.data.code, msg: error.response.data.msg, body: JSON.stringify(error.response.data) }; throw error; }
}

async function directGetAllPremiumIndexData() {
    try {
         const data = await directApiRequest('/fapi/v1/premiumIndex', 'GET'); const responseData = Array.isArray(data) ? data : (data ? [data] : []);
         if (!responseData || responseData.length === 0) { console.warn(chalk.yellow("PremiumIndex empty data.")); return []; }
         const results = responseData.map(item => ({ symbol: item.symbol, fundingRate: parseFloat(item.lastFundingRate) || 0, markPrice: parseFloat(item.markPrice), nextFundingTime: parseInt(item.nextFundingTime) }))
                                     .filter(item => item.symbol && !isNaN(item.fundingRate) && !isNaN(item.markPrice) && !isNaN(item.nextFundingTime) && item.markPrice > 0);
         return results;
     } catch (error) { console.error(chalk.red(`Error directGetAllPremiumIndexData:`), error.code, error.msg); return []; }
}

async function directSetLeverage(symbol, leverage) { return directApiRequest('/fapi/v1/leverage', 'POST', { symbol, leverage }); }
async function directPlaceLongSLOrder(symbol, quantity, stopPrice) { return directApiRequest('/fapi/v1/order', 'POST', { symbol, side: 'SELL', type: 'STOP_MARKET', quantity, stopPrice, reduceOnly: true, timeInForce: 'GTC' }); }


// --- SIGINT Handler ---
process.on('SIGINT', async () => {
    console.log(chalk.yellow.bold("\n\n! Ctrl+C detected. Shutting down... !")); isPlacingOrder = true;
    if (currentPosition?.symbol) {
        console.warn(chalk.red(`WARNING: Position ${currentPosition.positionSide} ${chalk.bold(currentPosition.symbol)} OPEN!`));
        console.warn(chalk.yellow(`   SL Order ID: ${currentPosition.orderIds?.sl || 'N/A'}`));
        if (currentPosition.profitCheckTimeoutId) { console.warn(chalk.yellow(`   Clearing pending Profit Check Timeout.`)); clearTimeout(currentPosition.profitCheckTimeoutId); }
        console.warn(chalk.red.bold(`   >>> MANUAL INTERVENTION required! <<<`));
    } else { console.log(chalk.green("No active position detected.")); }
    console.log(chalk.blue("Exiting script...")); process.exit(0);
});


// --- Start the Bot ---
// Ensure all functions are defined before calling initialize
initialize();
console.log("Initialize function called. Waiting for async operations...");