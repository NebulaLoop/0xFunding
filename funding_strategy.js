// funding_strategy.js

require('dotenv').config(); // Load environment variables from .env file
const Binance = require('node-binance-api');
const Table = require('cli-table3');
const chalk = require('chalk');
const axios = require('axios'); // For direct API calls
const crypto = require('crypto'); // For signing API requests

// --- Configuration ---
// !!! ใช้ API Key จาก .env เท่านั้น !!!
const USE_TESTNET = false; // Set to true to use testnet, false to use real trading

const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET_KEY = process.env.BINANCE_SECRET_KEY;

// Base URLs for direct API calls
const FUTURES_API_BASE = USE_TESTNET ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';

// Configure Binance API with appropriate endpoints for futures trading
const binance = new Binance().options({
    APIKEY: BINANCE_API_KEY,
    APISECRET: BINANCE_SECRET_KEY,
    recvWindow: 60000, // Increased for potential network latency
    urls: {
        base: `${FUTURES_API_BASE}/fapi/v1/`,
        wapi: `${FUTURES_API_BASE}/fapi/v1/`,
        stream: USE_TESTNET ? 'wss://stream.binancefuture.com/stream' : 'wss://fstream.binance.com/stream',
        margin: `${FUTURES_API_BASE}/fapi/v1/`,
        futures: `${FUTURES_API_BASE}/fapi/v1/`
    },
    family: 4, // IPv4, not IPv6
    test: USE_TESTNET,
    futures: true
});

// --- Strategy Parameters ---
const FUNDING_RATE_THRESHOLD = 0;  // 0 means include all negative rates
const INVESTMENT_USD = 100;
const LEVERAGE = 10;
const TAKE_PROFIT_PERCENT = 0.03;
const STOP_LOSS_PERCENT = 0.01;
// New parameters for position timing
const OPEN_POSITION_AFTER_FUNDING = true;  // Set to true to open position AFTER funding collection, false for BEFORE
const ENTRY_SECONDS_OFFSET = 5;  // Seconds before or after funding time to enter position
const CHECK_INTERVAL_MS = 10000;
const TOP_LIST_COUNT = 10;
const MAKER_FEE = 0.0002;
const TAKER_FEE = 0.0005;
const EXECUTE_TRADES = true;  // Set to false to monitor only (no trades will be executed)
const IGNORE_COUNTDOWN = false; // Set to true to open positions immediately without waiting for funding time
const VERIFY_SYMBOLS = true;   // Set to true to verify symbols with a test leverage request
const FORCE_REFRESH_DATA = true; // Force refresh data from API on every check to avoid caching issues

// --- State Variables ---
let currentPosition = null;
let tradeHistory = [];
let exchangeInfo = null;
let isPlacingOrder = false;
let tradableSymbols = new Set(); // Track which symbols are actually tradable
let verifiedSymbols = new Set(); // Track which symbols have been verified with a test API call
let lastDataFetchTime = null; // Track when we last fetched funding data

// --- Helper Functions --- (เหมือนเดิม)

function getSymbolPrecision(symbol) {
    if (!exchangeInfo) {
        console.warn(chalk.yellow("Exchange info not available yet."));
        return null;
    }
    const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === symbol && s.contractType === 'PERPETUAL');
    if (!symbolInfo) {
        // console.warn(chalk.yellow(`Precision info not found for symbol: ${symbol}`)); // ลด Log ลง
        return null;
    }
    try {
        return {
            symbol: symbol,
            pricePrecision: symbolInfo.pricePrecision,
            quantityPrecision: symbolInfo.quantityPrecision,
            minQty: parseFloat(symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE').minQty),
            tickSize: parseFloat(symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER').tickSize)
        };
    } catch (e) {
        console.error(chalk.red(`Error parsing precision filters for ${symbol}:`), e);
        return null;
    }
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

function calculateTradeMetrics(entryPrice, symbolPrecision) {
    if (!symbolPrecision || !entryPrice || entryPrice <= 0) {
        // console.warn(chalk.yellow(`Invalid input for calculateTradeMetrics: EntryPrice=${entryPrice}, Precision=${symbolPrecision?.symbol}`));
        return null;
    }

    const positionValue = INVESTMENT_USD * LEVERAGE;
    let quantity = positionValue / entryPrice;
    const formattedQuantity = formatQuantity(quantity, symbolPrecision.quantityPrecision);

    if (!formattedQuantity || formattedQuantity < symbolPrecision.minQty) {
        // console.warn(chalk.yellow(`Calc quantity ${formattedQuantity} for ${symbolPrecision.symbol} < minQty ${symbolPrecision.minQty}. Need $${(symbolPrecision.minQty * entryPrice).toFixed(2)}.`));
        return null;
    }

    const entryFee = positionValue * TAKER_FEE;
    const tpPriceRaw = entryPrice * (1 - TAKE_PROFIT_PERCENT);
    const slPriceRaw = entryPrice * (1 + STOP_LOSS_PERCENT);
    const tpPriceAdjusted = adjustPriceToTickSize(tpPriceRaw, symbolPrecision.tickSize);
    const slPriceAdjusted = adjustPriceToTickSize(slPriceRaw, symbolPrecision.tickSize);
    const formattedTpPrice = formatPrice(tpPriceAdjusted, symbolPrecision.pricePrecision);
    const formattedSlPrice = formatPrice(slPriceAdjusted, symbolPrecision.pricePrecision);

    if (formattedTpPrice >= entryPrice || formattedSlPrice <= entryPrice) {
        // console.warn(chalk.yellow(`TP/SL calc issue for ${symbolPrecision.symbol}: Entry=${entryPrice}, TP=${formattedTpPrice}, SL=${formattedSlPrice}.`));
        return null;
    }

    const potentialProfitUSD = positionValue * TAKE_PROFIT_PERCENT;
    const potentialLossUSD = positionValue * STOP_LOSS_PERCENT;
    const exitFeeTP = (positionValue * (1 - TAKE_PROFIT_PERCENT)) * MAKER_FEE;
    const exitFeeSL = (positionValue * (1 + STOP_LOSS_PERCENT)) * TAKER_FEE;
    const netProfit = potentialProfitUSD - entryFee - exitFeeTP;
    const netLoss = potentialLossUSD + entryFee + exitFeeSL;

    return {
        positionValue: positionValue.toFixed(2),
        quantity: formattedQuantity,
        entryFee: entryFee.toFixed(5),
        tpPrice: formattedTpPrice,
        slPrice: formattedSlPrice,
        netProfit: netProfit.toFixed(4),
        netLoss: netLoss.toFixed(4),
    };
}

function displayTopCandidates(candidates) {
    console.log(chalk.blueBright(`\n--- Top Funding Rate Candidates (Top 10 by Rate, Then Sorted by Next Funding Time) ---`));
    
    // แสดงเวลาที่ข้อมูลอัพเดตล่าสุด
    const updateTimeMsg = lastDataFetchTime ? 
        `Last data update: ${new Date(lastDataFetchTime).toLocaleTimeString()}` : 
        'Data not yet updated';
    console.log(chalk.cyan(updateTimeMsg));
    console.log(chalk.cyan(`Total candidates found: ${candidates.length}`));
    
    const table = new Table({
        head: [
            chalk.cyan('Rank'), chalk.cyan('Symbol'), chalk.cyan('Funding (%)'), chalk.cyan('Countdown'),
            chalk.cyan('Est. Qty'), chalk.cyan('TP Price'), chalk.cyan('SL Price'),
            chalk.cyan('Net Profit ($)'), chalk.cyan('Net Loss ($)'), chalk.cyan('Long Fee ($)')
        ],
        colWidths: [6, 15, 14, 13, 12, 12, 12, 16, 16, 14],
        style: { 'padding-left': 1, 'padding-right': 1, head: ['blue'], border: ['grey'] }
    });

    if (!candidates || candidates.length === 0) {
        console.log(chalk.yellow("   No candidates meet the criteria currently (Negative Rate & Upcoming Funding Time)."));
        return;
    }

    candidates.forEach((c, index) => {
        const metrics = c.metrics;
        // เพิ่มการตรวจสอบว่า funding rate เป็นข้อมูลล่าสุดหรือไม่
        const rateStyle = c.isRealtime ? 
            (c.fundingRate <= 0 ? chalk.red.bold : chalk.green.bold) : 
            (c.fundingRate <= 0 ? chalk.red : chalk.green);
        
        // Calculate funding fee for long position (includes fees calculation)
        const positionValue = parseFloat(metrics.positionValue);
        const longFundingFee = -positionValue * c.fundingRate; // Negative for positive funding rate (pay fee), positive for negative rate (receive fee)
        const entryFee = positionValue * TAKER_FEE;
        const totalLongFee = longFundingFee - entryFee; // Account for entry fee
        
        table.push([
            index + 1,
            c.symbol + (c.isRealtime ? '*' : ''),  // เพิ่มเครื่องหมาย * เพื่อระบุว่าเป็นข้อมูลเรียลไทม์
            rateStyle((c.fundingRate * 100).toFixed(4)),
            formatCountdown(c.countdownMs),
            metrics.quantity,
            metrics.tpPrice,
            metrics.slPrice,
            chalk.green(metrics.netProfit),
            chalk.red(metrics.netLoss),
            totalLongFee >= 0 ? chalk.green(totalLongFee.toFixed(4)) : chalk.red(totalLongFee.toFixed(4))
        ]);
    });
    console.log(table.toString());
    console.log(chalk.gray("* indicates realtime funding rate data from direct API call"));
    console.log(chalk.cyan("Long Fee ($): Amount you receive (if positive) or pay (if negative) per funding period when going long"));
}

async function displayCurrentPosition() {
    if (!currentPosition) {
        console.log(chalk.blue("\n--- No Active Position ---"));
        return;
    }

    console.log(chalk.yellow("\n--- Current Position ---"));
    try {
        const ticker = await binance.futuresMarkPrice(currentPosition.symbol);
        const markPrice = parseFloat(ticker.markPrice);
        const entryPrice = currentPosition.entryPrice;
        const quantity = currentPosition.quantity;
        const pnl = (entryPrice - markPrice) * quantity;
        const pricePrecision = getSymbolPrecision(currentPosition.symbol)?.pricePrecision || 2;

        const table = new Table({
             head: [chalk.cyan('Symbol'), chalk.cyan('Entry Price'), chalk.cyan('Mark Price'), chalk.cyan('Quantity'), chalk.cyan('Unrealized PNL ($)'), chalk.cyan('Entry Time')],
             style: { 'padding-left': 1, 'padding-right': 1, head: ['blue'], border: ['grey'] }
        });
        table.push([
            currentPosition.symbol,
            entryPrice.toFixed(pricePrecision),
            markPrice.toFixed(pricePrecision),
            quantity,
            pnl >= 0 ? chalk.green(pnl.toFixed(4)) : chalk.red(pnl.toFixed(4)),
            new Date(currentPosition.entryTimestamp).toLocaleTimeString()
        ]);
        console.log(table.toString());
        console.log(`   TP Order ID: ${currentPosition.orderIds?.tp || 'N/A'}, SL Order ID: ${currentPosition.orderIds?.sl || 'N/A'}`);

    } catch (error) {
        console.error(chalk.red(`Error fetching position PNL for ${currentPosition.symbol}:`), error.body || error.message);
        const table = new Table({ head: [chalk.cyan('Symbol'), chalk.cyan('Entry Price'), chalk.cyan('Quantity')] });
        table.push([currentPosition.symbol, currentPosition.entryPrice, currentPosition.quantity]);
        console.log(table.toString());
    }
}

function displayTradeHistory() {
    console.log(chalk.yellow("\n--- Trade History ---"));
    if (tradeHistory.length === 0) {
        console.log("   No trades recorded yet.");
        return;
    }
    const table = new Table({
        head: [
            chalk.cyan('Close Time'), chalk.cyan('Symbol'), chalk.cyan('Side'), chalk.cyan('Entry Price'),
            chalk.cyan('Exit Price'), chalk.cyan('Quantity'), chalk.cyan('Realized PNL ($)'), chalk.cyan('Reason')
        ],
        style: { 'padding-left': 1, 'padding-right': 1, head: ['blue'], border: ['grey'] }
    });
    [...tradeHistory].reverse().forEach(trade => {
         const pricePrecision = getSymbolPrecision(trade.symbol)?.pricePrecision || 2;
        table.push([
            new Date(trade.closeTimestamp).toLocaleString(),
            trade.symbol,
            'SHORT',
            trade.entryPrice.toFixed(pricePrecision),
            trade.exitPrice.toFixed(pricePrecision),
            trade.quantity,
            trade.pnl >= 0 ? chalk.green(trade.pnl.toFixed(4)) : chalk.red(trade.pnl.toFixed(4)),
            trade.reason
        ]);
    });
    console.log(table.toString());
}


// --- Main Logic ---
/**
 * Fetches data, analyzes candidates, and manages trading logic.
 * --- VERSION USING futuresMarkPrice FOR nextFundingTime ---
 */
async function fetchAndAnalyze() {
    if (isPlacingOrder) {
        console.log(chalk.yellow(`[${new Date().toLocaleTimeString()}] Skipping analysis: Order placement in progress.`));
        scheduleNextCheck();
        return;
    }
    console.log(`\n[${new Date().toLocaleTimeString()}] Fetching data...`);
    try {
        // 1. Fetch Data from BOTH endpoints simultaneously
        console.log("Fetching funding rates and premium index data...");
        const [fundingRates, premiumIndices] = await Promise.all([
            binance.futuresFundingRate(), // Gets symbol, fundingRate, fundingTime (last)
            binance.futuresMarkPrice() // Use futuresMarkPrice instead of futuresPremiumIndexTicker
        ]);
        console.log(`Retrieved ${fundingRates?.length || 0} funding rates, ${premiumIndices?.length || 0} premium index entries.`);
        lastDataFetchTime = Date.now(); // บันทึกเวลาที่อัพเดตข้อมูล

        // --- Basic Checks ---
        if (!fundingRates || fundingRates.length === 0) { 
            console.warn(chalk.yellow("Warning: No funding rate data received."));
            scheduleNextCheck(); 
            return; 
        }
        if (!premiumIndices || premiumIndices.length === 0) { 
            console.warn(chalk.yellow("Warning: No premium index data received.")); 
            scheduleNextCheck(); 
            return; 
        }
        // --- End Checks ---

        // 2. Create Map for nextFundingTime from premiumIndex data
        const premiumIndexMap = premiumIndices.reduce((map, item) => {
            const nextFundingTimestamp = parseInt(item.nextFundingTime, 10);
            if (!isNaN(nextFundingTimestamp) && nextFundingTimestamp > 0) {
                map[item.symbol] = { nextFundingTime: nextFundingTimestamp };
            }
            return map;
        }, {});
        console.log(`Created map with ${Object.keys(premiumIndexMap).length} symbols having valid nextFundingTime from premium index.`);

        // 3. Fetch FRESH Mark Prices
        const markPrices = await binance.futuresMarkPrice();
        if (!markPrices || markPrices.length === 0) { console.warn(chalk.yellow("Warning: No mark price data received.")); scheduleNextCheck(); return; }
        const markPriceMap = markPrices.reduce((map, item) => { map[item.symbol] = parseFloat(item.markPrice); return map; }, {});

        // 4. Filter & Map: Combine data
        console.log(`Filtering/Mapping candidates (Rate <= ${FUNDING_RATE_THRESHOLD}, USDT, Valid Data)...`);
        const nowTimestamp = Date.now();
        const initialCandidates = fundingRates
            .filter(rate => rate.symbol.endsWith('USDT'))
            .filter(rate => { const fr = parseFloat(rate.fundingRate); return !isNaN(fr) && fr <= FUNDING_RATE_THRESHOLD; })
            .map(rate => {
                const symbol = rate.symbol;
                const premiumData = premiumIndexMap[symbol]; // Data from premiumIndexTicker
                const currentMarkPrice = markPriceMap[symbol]; // Fresh mark price

                if (!premiumData || !currentMarkPrice) { return null; } // Need data from both

                const nextFundingTimestamp = premiumData.nextFundingTime; // Already parsed and validated in map creation
                const symbolPrecision = getSymbolPrecision(symbol);
                if (!symbolPrecision) { return null; }

                const metrics = calculateTradeMetrics(currentMarkPrice, symbolPrecision);
                if (!metrics) { return null; }

                const countdownMs = nextFundingTimestamp - nowTimestamp;

                return {
                    symbol: symbol,
                    fundingRate: parseFloat(rate.fundingRate),
                    fundingTime: nextFundingTimestamp, // Store correct next time
                    countdownMs: countdownMs,
                    markPrice: currentMarkPrice,
                    metrics: metrics,
                    precision: symbolPrecision,
                    isRealtime: false // จะถูกอัพเดตในขั้นตอนต่อไปถ้าเป็นข้อมูล realtime
                };
            })
            .filter(candidate => candidate !== null);

        // Remove duplicates - keep the one with the most negative funding rate for each symbol
        console.log("Removing duplicate symbols from candidates...");
        const uniqueSymbolMap = new Map();
        
        // For each symbol, keep only the entry with the most negative funding rate
        initialCandidates.forEach(candidate => {
            const symbol = candidate.symbol;
            if (!uniqueSymbolMap.has(symbol) || 
                candidate.fundingRate < uniqueSymbolMap.get(symbol).fundingRate) {
                uniqueSymbolMap.set(symbol, candidate);
            }
        });
        
        // Convert the map values back to an array
        const dedupedCandidates = Array.from(uniqueSymbolMap.values());
        
        console.log(`Removed ${initialCandidates.length - dedupedCandidates.length} duplicates. Now have ${dedupedCandidates.length} unique candidates.`);
        
        // Replace the old array with the deduplicated one
        initialCandidates.length = 0; // Clear array
        initialCandidates.push(...dedupedCandidates); // Add unique candidates back to original array

        // --- NEW FEATURE: Fetch current funding rates directly for top candidates ---
        // เพิ่มส่วนนี้เพื่อดึงข้อมูล funding rate ล่าสุดจาก API โดยตรง
        console.log(chalk.cyan(`Fetching realtime funding rates for all available symbols...`));
        
        // Get all available USDT-margined futures symbols
        const allSymbols = Array.from(tradableSymbols).filter(s => s.endsWith('USDT'));
        console.log(chalk.cyan(`Found ${allSymbols.length} total USDT symbols for funding rate check`));
        
        // Get realtime funding rates for all symbols
        const realtimeRates = await directGetCurrentFundingRates(allSymbols);
        
        if (realtimeRates.length > 0) {
            console.log(chalk.green(`Received realtime funding rates for ${realtimeRates.length} symbols`));
            
            // Sort by funding rate (ascending - most negative first)
            realtimeRates.sort((a, b) => a.fundingRate - b.fundingRate);
            
            // Show all negative funding rates in log
            const negativeFundingSymbols = realtimeRates
                .filter(item => item.fundingRate < 0);  // Only negative funding rates
            
            console.log(chalk.cyan(`Found ${negativeFundingSymbols.length} symbols with negative funding rates:`));
            negativeFundingSymbols.slice(0, 20).forEach((item, index) => {
                console.log(chalk.cyan(`${index + 1}. ${item.symbol}: ${(item.fundingRate * 100).toFixed(4)}%`));
            });
            
            // IMPORTANT: Create fresh candidates from API data directly instead of filtering existing
            initialCandidates.length = 0; // Clear existing candidates
            
            // Create new candidates from realtime API data
            for (const item of negativeFundingSymbols) {
                const symbol = item.symbol;
                const symbolPrecision = getSymbolPrecision(symbol);
                if (!symbolPrecision) continue;
                
                const metrics = calculateTradeMetrics(item.markPrice, symbolPrecision);
                if (!metrics) continue;
                
                const nowTimestamp = Date.now();
                const countdownMs = item.nextFundingTime - nowTimestamp;
                
                initialCandidates.push({
                    symbol: symbol,
                    fundingRate: item.fundingRate,
                    fundingTime: item.nextFundingTime,
                    countdownMs: countdownMs,
                    markPrice: item.markPrice,
                    metrics: metrics,
                    precision: symbolPrecision,
                    isRealtime: true
                });
            }
            
            console.log(chalk.green(`Created ${initialCandidates.length} new candidates directly from API funding rate data`));
            lastDataFetchTime = Date.now();
        } else {
            console.log(chalk.yellow("No realtime funding rate data received from API, using fallback data"));
        }

        console.log(`Found ${initialCandidates.length} candidates after initial filter & map using combined data.`);
        if (initialCandidates.length === 0) { /* ... */ displayTopCandidates([]); /*...*/ scheduleNextCheck(); return; }

        // STEP 1: Sort first by funding rate (most negative first)
        initialCandidates.sort((a, b) => a.fundingRate - b.fundingRate);
        console.log(`Sorted ${initialCandidates.length} candidates by funding rate (most negative first)`);
        
        // STEP 2: Get the top 10 candidates by funding rate
        const topTenByRate = initialCandidates.slice(0, TOP_LIST_COUNT);
        console.log(`Selected top ${topTenByRate.length} candidates by funding rate`);
        
        // STEP 3: Now sort just these top 10 by Next Funding Time (earliest first)
        topTenByRate.sort((a, b) => a.countdownMs - b.countdownMs);
        console.log(`Re-sorted top ${topTenByRate.length} candidates by Next Funding Time (earliest first)`);

        // 6. Use the top 10 sorted by funding rate then by time
        const finalCandidates = topTenByRate;
        console.log(`Using two-stage sorted ${finalCandidates.length} candidates`);

        // 7. Display Top Candidates
        displayTopCandidates(finalCandidates);

        // 8. Check for Trading Opportunity
        const topCandidate = finalCandidates.length > 0 ? finalCandidates[0] : null;

        if (topCandidate && !currentPosition && !isPlacingOrder) {
            const timeRemainingSec = topCandidate.countdownMs / 1000;
            console.log(chalk.cyan(`Top candidate by Time & Rate: ${topCandidate.symbol} (Rate: ${(topCandidate.fundingRate*100).toFixed(4)}%), Countdown: ${formatCountdown(topCandidate.countdownMs)}`));
            
            // Check if we should ignore the countdown timer or if we're within the entry window
            if (IGNORE_COUNTDOWN) {
                console.log(chalk.magenta(`>>> IGNORE_COUNTDOWN is enabled. Opening SHORT position for ${topCandidate.symbol} immediately...`));
                await placeTrade(topCandidate);
            } 
            // Check if we should open position AFTER funding (based on new parameter)
            else if (OPEN_POSITION_AFTER_FUNDING && timeRemainingSec < 0 && Math.abs(timeRemainingSec) <= ENTRY_SECONDS_OFFSET) {
                console.log(chalk.magenta(`>>> ${Math.abs(timeRemainingSec).toFixed(1)}s after funding time for ${topCandidate.symbol}. Opening SHORT position after funding collection...`));
                await placeTrade(topCandidate);
            }
            // Original behavior - opening position BEFORE funding collection
            else if (!OPEN_POSITION_AFTER_FUNDING && timeRemainingSec > 0 && timeRemainingSec <= ENTRY_SECONDS_OFFSET) {
                console.log(chalk.magenta(`>>> Approaching funding time for ${topCandidate.symbol} (${timeRemainingSec.toFixed(1)}s before funding). Opening SHORT position...`));
                await placeTrade(topCandidate);
            }
        } else if (currentPosition) {
            await checkPositionStatus();
        } else if(isPlacingOrder) {
            console.log(chalk.yellow("Holding analysis loop: Order placement function is active."));
        }

        // Display status sections
        await displayCurrentPosition();
        displayTradeHistory();

    } catch (error) {
        console.error(chalk.red(`Error in fetchAndAnalyze loop:`), error.body || error.message || error);
        // Specific check for the "not a function" error is less needed now, but general error handling remains
        if (error?.code === -1021) { console.error(chalk.yellow('Timestamp out of sync error. Check server time.')); }
        else if (error?.code === -2015 || error?.message?.includes('Invalid API-key')) { console.error(chalk.red('Invalid API Key or Secret. Check .env file & permissions. Exiting.')); process.exit(1); }
    } finally {
        scheduleNextCheck();
    }
}

function scheduleNextCheck() {
     setTimeout(fetchAndAnalyze, CHECK_INTERVAL_MS);
}

// --- Functions placeTrade, checkPositionStatus, initialize, SIGINT handler ---
// --- (These functions remain unchanged from the previous version) ---

async function placeTrade(candidate) {
    if (isPlacingOrder) {
        console.warn(chalk.yellow("Aborting trade placement: Another placement is already in progress."));
        return;
    }
    isPlacingOrder = true;

    const symbol = candidate.symbol;
    const metrics = candidate.metrics;
    const quantity = metrics.quantity;
    const tpPrice = metrics.tpPrice;
    const slPrice = metrics.slPrice;

    console.log(chalk.blue(`\n=== Attempting SHORT Entry for ${symbol} ===`));
    console.log(`   Leverage: ${LEVERAGE}x, Quantity: ${quantity}, TP: ${tpPrice}, SL: ${slPrice}`);

    // Check if trade execution is enabled
    if (!EXECUTE_TRADES) {
        console.log(chalk.yellow(`   SIMULATION MODE: Trade would be executed now, but EXECUTE_TRADES is set to false.`));
        console.log(chalk.yellow(`   To enable actual trading, set EXECUTE_TRADES to true in the strategy parameters.`));
        isPlacingOrder = false;
        return;
    }
    
    // Check if symbol is actually tradable on futures
    if (!tradableSymbols.has(symbol)) {
        console.error(chalk.red(`\n--- Symbol ${symbol} not found in tradable symbols list ---`));
        console.error(chalk.yellow('This symbol is likely not available for futures trading on Binance.'));
        console.log("   Skipping trade placement. No position opened.");
        isPlacingOrder = false;
        return;
    }

    try {
        console.log(`   1. Setting leverage to ${LEVERAGE}x for ${symbol}...`);
        await directSetLeverage(symbol, LEVERAGE);
        console.log(chalk.green(`      Leverage set successfully.`));

        console.log(`   2. Placing MARKET SELL order for ${quantity} ${symbol}...`);
        const entryOrder = await binance.futuresMarketSell(symbol, quantity, { newOrderRespType: 'RESULT' });
        console.log(chalk.green(`      Market SELL order placed successfully.`), `Order ID: ${entryOrder.orderId}`);

        const executedQty = parseFloat(entryOrder.executedQty) || quantity;
        let entryPrice = parseFloat(entryOrder.avgPrice);
        if (!entryPrice || entryPrice <= 0) {
            console.warn(chalk.yellow(`      avgPrice not available, using candidate mark price ${candidate.markPrice} as estimate.`));
            entryPrice = candidate.markPrice;
        } else {
             console.log(`      Actual Entry Price: ${entryPrice.toFixed(candidate.precision.pricePrecision)}`);
        }

        currentPosition = {
            symbol: symbol,
            entryPrice: entryPrice,
            quantity: executedQty,
            positionAmt: -executedQty,
            entryTimestamp: entryOrder.updateTime || Date.now(),
            orderIds: { tp: null, sl: null }
        };
        console.log(chalk.green(`   Position Opened: ${symbol} @ ~${entryPrice}, Qty: ${executedQty}`));

        try {
            console.log(`   3. Placing BUY LIMIT (TP) order for ${executedQty} ${symbol} @ ${tpPrice}...`);
            const tpOrder = await directPlaceTPOrder(symbol, executedQty, tpPrice);
            currentPosition.orderIds.tp = tpOrder.orderId;
            console.log(chalk.green(`      TP order placed: ID ${tpOrder.orderId}`));
        } catch (tpError) {
            console.error(chalk.red(`   Error placing TP order for ${symbol}:`), tpError.body || tpError.message);
        }

        try {
            console.log(`   4. Placing BUY STOP_MARKET (SL) order for ${executedQty} ${symbol}, Trigger @ ${slPrice}...`);
            const slOrder = await directPlaceSLOrder(symbol, executedQty, slPrice);
             currentPosition.orderIds.sl = slOrder.orderId;
            console.log(chalk.green(`      SL order placed: ID ${slOrder.orderId}`));
        } catch (slError) {
            console.error(chalk.red(`   Error placing SL order for ${symbol}:`), slError.body || slError.message);
             console.error(chalk.red.bold(`   !!! POSITION OPEN WITHOUT STOP LOSS PROTECTION for ${symbol} !!!`));
        }
        console.log(chalk.blue(`=== Finished Trade Placement for ${symbol} ===`));

    } catch (error) {
        // Improved error handling with HTML detection
        const errorMsg = error.body || error.message || error;
        console.error(chalk.red(`\n--- Error during trade placement for ${candidate.symbol}: ---`));
        
        // Check if the error response is HTML (likely a 404 or other webpage error)
        if (typeof errorMsg === 'string' && (errorMsg.includes('<!DOCTYPE html>') || errorMsg.includes('<html>'))) {
            console.error(chalk.red('Received HTML error response from Binance API.'));
            console.error(chalk.yellow('This usually indicates:'));
            console.error(chalk.yellow('1. The API endpoint is incorrect or has changed'));
            console.error(chalk.yellow('2. The symbol may not be tradable on futures'));
            console.error(chalk.yellow('3. There might be temporary server issues at Binance'));
            console.error(chalk.yellow(`Check if "${symbol}" is available for futures trading on Binance.`));
        } 
        // Regular JSON error handling
        else {
            console.error(errorMsg);
            if (error.body?.includes('Insufficient margin')) { 
                console.error(chalk.yellow('Check available balance/leverage.')); 
            }
            else if (error.body?.includes('MIN_NOTIONAL') || error.body?.includes('LOT_SIZE')) { 
                console.error(chalk.yellow(`Order size issue (MIN_NOTIONAL or LOT_SIZE). Check INVESTMENT_USD vs price/minQty.`));
            }
        }
        
        if (!currentPosition) { 
            console.log("   Entry order likely failed. No position opened."); 
        }
        else { 
            console.error(chalk.red.bold("   Entry succeeded but TP/SL may have failed. MANUAL CHECK REQUIRED!")); 
        }
    } finally {
        isPlacingOrder = false;
    }
 }

async function checkPositionStatus() {
    if (!currentPosition || !currentPosition.symbol || isPlacingOrder) return;

    const symbol = currentPosition.symbol;
    const entryTimestamp = currentPosition.entryTimestamp;
    const tpOrderId = currentPosition.orderIds.tp;
    const slOrderId = currentPosition.orderIds.sl;

    try {
        const positionRisk = await binance.futuresPositionRisk({ symbol: symbol });
        const pos = positionRisk.find(p => p.symbol === symbol);
        const currentPositionAmt = pos ? parseFloat(pos.positionAmt) : 0;

        if (currentPositionAmt === 0) {
             console.log(chalk.magenta(`\nPosition ${symbol} appears closed. Checking history...`));
             let closingTrade = null;
             let reason = 'Unknown/Manual';
             let exitPrice = (pos ? parseFloat(pos.markPrice) : null) || currentPosition.entryPrice;
             let realizedPnl = pos ? parseFloat(pos.unRealizedProfit) : 0;

             try {
                const trades = await binance.futuresUserTrades(symbol, { limit: 15, startTime: entryTimestamp - 5000 });
                const closingTrades = trades.filter(t =>
                    t.symbol === symbol && t.side === 'BUY' &&
                    // Use Math.abs for quantity comparison due to potential float issues
                    Math.abs(parseFloat(t.qty) - currentPosition.quantity) < (currentPosition.quantity * 0.001) && // Allow tiny diff
                    t.time >= entryTimestamp && parseFloat(t.realizedPnl) !== 0
                ).sort((a, b) => b.time - a.time);

                if (closingTrades.length > 0) {
                    closingTrade = closingTrades[0];
                    exitPrice = parseFloat(closingTrade.price);
                    realizedPnl = parseFloat(closingTrade.realizedPnl);
                    reason = `Closed (Trade ${closingTrade.orderId})`;
                    console.log(`   Found closing trade: ID ${closingTrade.id}, Order ID ${closingTrade.orderId}, Price ${exitPrice}, PNL ${realizedPnl}`);
                    if (closingTrade.orderId == tpOrderId) reason = 'TP Hit'; // Use == for potential type diff
                    else if (closingTrade.orderId == slOrderId) reason = 'SL Hit'; // Use ==
                    else reason = 'Closed (API/Manual)';
                } else {
                     console.warn(chalk.yellow(`   Could not find specific closing trade for ${symbol}. PNL from last known position used.`));
                     reason = 'Liquidation/Other';
                 }
             } catch (tradeError) {
                  console.error(chalk.red(`   Error fetching user trades for ${symbol}:`), tradeError.body || tradeError.message);
                  reason = 'History Error';
             }

            tradeHistory.push({
                closeTimestamp: closingTrade?.time || Date.now(),
                symbol: symbol,
                entryPrice: currentPosition.entryPrice,
                exitPrice: exitPrice,
                quantity: currentPosition.quantity,
                pnl: realizedPnl,
                reason: reason
            });

             console.log("   Attempting to cancel any residual TP/SL orders...");
             if (tpOrderId) await binance.futuresCancel(symbol, { orderId: tpOrderId }).catch(e => {});
             if (slOrderId) await binance.futuresCancel(symbol, { orderId: slOrderId }).catch(e => {});

            console.log(chalk.magenta(`Position ${symbol} processing complete. Reason: ${reason}. Final PNL: ${realizedPnl.toFixed(4)}`));
            currentPosition = null;
        }
    } catch (error) {
        console.error(chalk.red(`Error checking position status for ${symbol}:`), error.body || error.message);
    }
}


async function initialize() {
    console.log(chalk.bold.blue("===== Funding Rate Strategy Bot Initializing ====="));
    if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY) { 
        console.error(chalk.red.bold("ERROR: API Keys not found in .env file! Exiting.")); 
        process.exit(1); 
    }
    console.log("API Keys found in .env file.");
    
    try {
        console.log("Fetching Exchange Info...");
        exchangeInfo = await binance.futuresExchangeInfo();
        if (!exchangeInfo || !exchangeInfo.symbols || exchangeInfo.symbols.length === 0) { 
            console.error(chalk.red.bold("Failed to fetch valid Exchange Info. Exiting.")); 
            process.exit(1); 
        }
        console.log(chalk.green(`Exchange Info fetched successfully (${exchangeInfo.symbols.length} symbols).`));
        
        // Build a detailed tradable symbols list
        console.log("Building tradable symbols list...");
        tradableSymbols.clear(); // Clear existing set if any
        verifiedSymbols.clear(); // Clear verified symbols list
        
        let unavailableCount = 0;
        let marginTypeErrorCount = 0;
        
        for (const symbolInfo of exchangeInfo.symbols) {
            // Only add symbols that are actively trading and are perpetual futures
            if (symbolInfo.status === 'TRADING' && 
                symbolInfo.contractType === 'PERPETUAL' && 
                symbolInfo.symbol.endsWith('USDT')) {
                
                tradableSymbols.add(symbolInfo.symbol);
            } else if (symbolInfo.symbol.endsWith('USDT')) {
                unavailableCount++;
                if (symbolInfo.status !== 'TRADING') {
                    console.log(chalk.yellow(`Symbol ${symbolInfo.symbol} not tradable (status: ${symbolInfo.status})`));
                }
                if (symbolInfo.contractType !== 'PERPETUAL') {
                    console.log(chalk.yellow(`Symbol ${symbolInfo.symbol} not perpetual (type: ${symbolInfo.contractType})`));
                }
            }
        }
        
        console.log(chalk.green(`Identified ${tradableSymbols.size} tradable USDT perpetual symbols.`));
        if (unavailableCount > 0) {
            console.log(chalk.yellow(`${unavailableCount} USDT symbols are not available for trading (non-TRADING status or non-PERPETUAL).`));
        }
        
        // Get a list of specific symbols that would be candidates based on history
        const commonSymbols = [
            'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'AERGOUSDT', 'INJUSDT', 
            'DOGEUSDT', 'MATICUSDT', 'ADAUSDT', 'XRPUSDT', 'VOXELUSDT', 'MAGICUSDT'
        ];
        
        // Check if common trading pairs are available
        console.log(chalk.cyan("\nChecking specific common trading pairs:"));
        if (VERIFY_SYMBOLS) {
            console.log(chalk.yellow("Performing practical verification of each symbol with API test calls..."));
            for (const symbol of commonSymbols) {
                const isVerified = await verifySymbol(symbol);
                if (isVerified) {
                    console.log(chalk.green(`✓ ${symbol} is verified and available for futures trading`));
                } else {
                    console.log(chalk.red(`✗ ${symbol} is NOT available for futures trading`));
                    // Make sure it's removed from tradable symbols
                    tradableSymbols.delete(symbol);
                }
            }
        } else {
            // Simple check based on exchange info only (less accurate)
            for (const symbol of commonSymbols) {
                if (tradableSymbols.has(symbol)) {
                    console.log(chalk.yellow(`? ${symbol} appears available in exchange info (unverified)`));
                } else {
                    console.log(chalk.red(`✗ ${symbol} is NOT available for futures trading`));
                }
            }
        }

        console.log("Checking API key validity (fetching balance)...");
        await binance.futuresBalance();
        console.log(chalk.green("API keys seem valid and have Futures access."));
        console.log(chalk.blue("Starting analysis loop... Interval:", CHECK_INTERVAL_MS / 1000, "s."));
        console.log(chalk.yellow(`Strategy Params: FundRate <= ${FUNDING_RATE_THRESHOLD}, Invest=${INVESTMENT_USD}$, Lev=${LEVERAGE}x, TP=${TAKE_PROFIT_PERCENT*100}%, SL=${STOP_LOSS_PERCENT*100}%`));
        fetchAndAnalyze();
    } catch (error) {
        console.error(chalk.red.bold("\nInitialization failed:"), error.body || error.message || error);
        if (error?.code === -2015 || error?.message?.includes('Invalid API-key')) { 
            console.error(chalk.red('-> Invalid API Key/Secret or insufficient permissions.')); 
        } else if (error?.code === -1003) { 
            console.error(chalk.red('-> API Rate limit hit during init.')); 
        }
        process.exit(1);
    }
 }

async function verifySymbol(symbol) {
    if (verifiedSymbols.has(symbol)) {
        return true; // Already verified
    }
    
    try {
        // First check if the symbol exists by getting its mark price, which is a lightweight call
        const markPrice = await binance.futuresMarkPrice(symbol);
        
        if (markPrice) {
            // Then try to set leverage using the POST method
            await directSetLeverage(symbol, LEVERAGE);
            
            // If both API calls succeed, symbol is tradable
            verifiedSymbols.add(symbol);
            return true;
        }
        return false;
    } catch (error) {
        const errorMsg = error.body || error.message || error;
        
        // HTML response usually means symbol doesn't exist or API endpoint issue
        if (typeof errorMsg === 'string' && (errorMsg.includes('<!DOCTYPE html>') || errorMsg.includes('<html>'))) {
            console.log(chalk.red(`${symbol} verification failed: HTML error response (symbol likely not tradable)`));
        } else if (error.code === -5000 && error.msg?.includes('Path /fapi/v1/leverage')) {
            // This is the specific error we're seeing with the API path
            console.log(chalk.red(`${symbol} verification failed: API endpoint issue. Please update node-binance-api package.`));
            // We'll mark it as verified since the error is with the API method, not the symbol
            console.log(chalk.yellow(`Temporarily marking ${symbol} as provisionally available. Will verify during actual trade.`));
            verifiedSymbols.add(symbol);
            return true;
        } else {
            // Check for specific error codes that indicate symbol isn't tradable
            if (error.code === -1121 || error.code === -1128) {
                console.log(chalk.red(`${symbol} verification failed: Invalid symbol error`));
            } else {
                console.log(chalk.red(`${symbol} verification failed: ${JSON.stringify(errorMsg)}`));
            }
        }
        
        // Remove from tradable symbols list if present
        tradableSymbols.delete(symbol);
        return false;
    }
}

process.on('SIGINT', async () => {
    console.log(chalk.yellow.bold("\n\n! Caught interrupt signal (Ctrl+C). Shutting down... !"));
    if (isPlacingOrder) { console.warn(chalk.red.bold("WARNING: Shutdown initiated while an order placement was in progress! MANUAL CHECK REQUIRED!")); }
    if (currentPosition && currentPosition.symbol) {
        console.warn(chalk.red(`WARNING: Position for ${chalk.bold(currentPosition.symbol)} is OPEN!`));
        console.warn(chalk.yellow(`   TP Order ID: ${currentPosition.orderIds?.tp || 'N/A'}, SL Order ID: ${currentPosition.orderIds?.sl || 'N/A'}`));
        console.warn(chalk.red.bold(`   >>> Manual intervention on Binance may be required! <<<`));
    } else { console.log(chalk.green("No active position detected.")); }
    console.log(chalk.blue("Exiting script."));
    process.exit(0);
});

// --- Start the Bot ---
initialize();

// --- Direct API Call Functions ---
/**
 * Creates a signature for Binance API request using HMAC SHA256
 */
function createSignature(queryString) {
    return crypto
        .createHmac('sha256', BINANCE_SECRET_KEY)
        .update(queryString)
        .digest('hex');
}

/**
 * Direct implementation to get current funding rates for multiple symbols
 * This bypasses any potential caching issues with the node-binance-api library
 */
async function directGetCurrentFundingRates(symbols = []) {
    try {
        // เพิ่มการเรียก API แบบ batch เพื่อลดการเรียก API หลายครั้ง
        const timestamp = Date.now();
        let apiUrl = `${FUTURES_API_BASE}/fapi/v1/premiumIndex?timestamp=${timestamp}`;
        
        // เพิ่ม symbols เข้าไปใน query string ถ้ามีการระบุ
        if (symbols.length > 0) {
            const symbolParam = symbols.join('","');
            apiUrl += `&symbols=["${symbolParam}"]`;
        }
        
        const signature = createSignature(apiUrl.split('?')[1]);
        apiUrl += `&signature=${signature}`;
        
        const response = await axios({
            method: 'GET',
            url: apiUrl,
            headers: {
                'X-MBX-APIKEY': BINANCE_API_KEY
            }
        });
        
        if (!Array.isArray(response.data)) {
            console.warn(chalk.yellow('API did not return an array of funding rates.'));
            return [];
        }
        
        // แปลงข้อมูลให้อยู่ในรูปแบบที่ใช้งานง่าย
        const results = response.data.map(item => ({
            symbol: item.symbol,
            fundingRate: parseFloat(item.lastFundingRate),
            markPrice: parseFloat(item.markPrice),
            nextFundingTime: parseInt(item.nextFundingTime)
        })).filter(item => !isNaN(item.fundingRate) && !isNaN(item.nextFundingTime));
        
        console.log(chalk.green(`Successfully fetched current funding rates for ${results.length} symbols directly from API`));
        return results;
    } catch (error) {
        console.error(chalk.red(`Error getting current funding rates:`), 
            error.response?.data || error.message || error);
        return [];
    }
}

/**
 * Direct implementation to get the most current funding rate for a specific symbol
 * This bypasses any potential caching issues with the node-binance-api library
 */
async function directGetCurrentFundingRate(symbol) {
    try {
        const timestamp = Date.now();
        const queryParams = `symbol=${symbol}&timestamp=${timestamp}`;
        const signature = createSignature(queryParams);
        
        const url = `${FUTURES_API_BASE}/fapi/v1/premiumIndex?${queryParams}&signature=${signature}`;
        
        const response = await axios({
            method: 'GET',
            url,
            headers: {
                'X-MBX-APIKEY': BINANCE_API_KEY
            }
        });
        
        if (response.data && response.data.lastFundingRate) {
            return {
                symbol: response.data.symbol,
                fundingRate: parseFloat(response.data.lastFundingRate),
                markPrice: parseFloat(response.data.markPrice),
                nextFundingTime: parseInt(response.data.nextFundingTime)
            };
        }
        return null;
    } catch (error) {
        console.error(chalk.red(`Error getting current funding rate for ${symbol}:`), 
            error.response?.data || error.message || error);
        return null;
    }
}

/**
 * Direct implementation of leverage setting API call to avoid node-binance-api issues
 */
async function directSetLeverage(symbol, leverage) {
    try {
        const timestamp = Date.now();
        const queryParams = `symbol=${symbol}&leverage=${leverage}&timestamp=${timestamp}`;
        const signature = createSignature(queryParams);
        
        const url = `${FUTURES_API_BASE}/fapi/v1/leverage?${queryParams}&signature=${signature}`;
        
        const response = await axios({
            method: 'POST',
            url,
            headers: {
                'X-MBX-APIKEY': BINANCE_API_KEY
            }
        });
        
        return response.data;
    } catch (error) {
        if (error.response) {
            throw {
                code: error.response.data.code,
                msg: error.response.data.msg
            };
        }
        throw error;
    }
}

/**
 * Direct implementation of placing a Take Profit order (LIMIT order)
 */
async function directPlaceTPOrder(symbol, quantity, price) {
    try {
        const timestamp = Date.now();
        const queryParams = `symbol=${symbol}&side=BUY&type=LIMIT&timeInForce=GTC&quantity=${quantity}&price=${price}&reduceOnly=true&timestamp=${timestamp}`;
        const signature = createSignature(queryParams);
        
        const url = `${FUTURES_API_BASE}/fapi/v1/order?${queryParams}&signature=${signature}`;
        
        const response = await axios({
            method: 'POST',
            url,
            headers: {
                'X-MBX-APIKEY': BINANCE_API_KEY
            }
        });
        
        return response.data;
    } catch (error) {
        if (error.response) {
            throw {
                code: error.response.data.code,
                msg: error.response.data.msg
            };
        }
        throw error;
    }
}

/**
 * Direct implementation of placing a Stop Loss order (STOP_MARKET order)
 */
async function directPlaceSLOrder(symbol, quantity, stopPrice) {
    try {
        const timestamp = Date.now();
        const queryParams = `symbol=${symbol}&side=BUY&type=STOP_MARKET&timeInForce=GTC&quantity=${quantity}&stopPrice=${stopPrice}&reduceOnly=true&timestamp=${timestamp}`;
        const signature = createSignature(queryParams);
        
        const url = `${FUTURES_API_BASE}/fapi/v1/order?${queryParams}&signature=${signature}`;
        
        const response = await axios({
            method: 'POST',
            url,
            headers: {
                'X-MBX-APIKEY': BINANCE_API_KEY
            }
        });
        
        return response.data;
    } catch (error) {
        if (error.response) {
            throw {
                code: error.response.data.code,
                msg: error.response.data.msg
            };
        }
        throw error;
    }
}