// getFundingRates.js - Script to check funding rates using CURL or Axios
// April 21, 2025

const { exec } = require('child_process');
const axios = require('axios');
const chalk = require('chalk');
const Table = require('cli-table3');

// --- Configuration ---
const BINANCE_API_URL = 'https://fapi.binance.com'; // Use testnet URL if testing: 'https://testnet.binancefuture.com'
const TOP_SYMBOLS_TO_SHOW = 20; // Number of symbols to display in the output
const SORT_BY_FUNDING_RATE = true; // true = sort by funding rate, false = sort alphabetically

// --- Function to get funding rates using CURL command ---
function getFundingRatesWithCurl() {
    console.log(chalk.cyan('Fetching funding rates using CURL command...'));
    
    // The CURL command to check funding rates
    const curlCommand = `curl -X GET "${BINANCE_API_URL}/fapi/v1/premiumIndex" -H "Content-Type: application/json"`;
    
    // Print the CURL command for reference
    console.log(chalk.yellow('\nCURL Command:'));
    console.log(curlCommand);
    console.log('\n');
    
    // Execute the CURL command
    exec(curlCommand, (error, stdout, stderr) => {
        if (error) {
            console.error(chalk.red('Error executing CURL command:'), error);
            return;
        }
        
        if (stderr) {
            console.error(chalk.yellow('CURL stderr:'), stderr);
        }
        
        try {
            const response = JSON.parse(stdout);
            displayFundingRates(response);
        } catch (parseError) {
            console.error(chalk.red('Error parsing CURL response:'), parseError);
            console.log(stdout);
        }
    });
}

// --- Function to get funding rates using Axios ---
async function getFundingRatesWithAxios() {
    console.log(chalk.cyan('Fetching funding rates using Axios...'));
    
    try {
        const response = await axios.get(`${BINANCE_API_URL}/fapi/v1/premiumIndex`);
        displayFundingRates(response.data);
    } catch (error) {
        console.error(chalk.red('Error fetching funding rates with Axios:'), 
            error.response?.data || error.message);
    }
}

// --- Function to display funding rates in a table ---
function displayFundingRates(data) {
    if (!Array.isArray(data) || data.length === 0) {
        console.log(chalk.red('No funding rate data received.'));
        return;
    }
    
    console.log(chalk.green(`Received funding rates for ${data.length} symbols.`));
    
    // Filter to only include USDT pairs
    const usdtPairs = data.filter(item => item.symbol.endsWith('USDT'));
    
    // Sort by funding rate (most negative first) if configured
    if (SORT_BY_FUNDING_RATE) {
        usdtPairs.sort((a, b) => parseFloat(a.lastFundingRate) - parseFloat(b.lastFundingRate));
    } else {
        usdtPairs.sort((a, b) => a.symbol.localeCompare(b.symbol));
    }
    
    // Create a table to display the data
    const table = new Table({
        head: [
            chalk.cyan('Rank'),
            chalk.cyan('Symbol'), 
            chalk.cyan('Funding Rate (%)'), 
            chalk.cyan('Mark Price'),
            chalk.cyan('Next Funding Time')
        ],
        colWidths: [6, 12, 18, 15, 25],
        style: { 'padding-left': 1, 'padding-right': 1, head: ['blue'], border: ['grey'] }
    });
    
    // Add data to the table
    usdtPairs.slice(0, TOP_SYMBOLS_TO_SHOW).forEach((item, index) => {
        const fundingRate = parseFloat(item.lastFundingRate) * 100;
        const fundingRateStr = fundingRate.toFixed(4) + '%';
        const nextFundingTime = new Date(parseInt(item.nextFundingTime));
        
        table.push([
            index + 1,
            item.symbol,
            fundingRate < 0 ? chalk.red(fundingRateStr) : chalk.green(fundingRateStr),
            parseFloat(item.markPrice).toString(),
            nextFundingTime.toLocaleString()
        ]);
    });
    
    console.log(table.toString());
    
    // Display summary stats
    const negativeRates = usdtPairs.filter(item => parseFloat(item.lastFundingRate) < 0);
    console.log(chalk.cyan(`Total USDT pairs: ${usdtPairs.length}`));
    console.log(chalk.red(`Pairs with negative funding rates: ${negativeRates.length}`));
    
    const mostNegativeRate = Math.min(...usdtPairs.map(item => parseFloat(item.lastFundingRate)));
    const mostNegativeSymbol = usdtPairs.find(item => parseFloat(item.lastFundingRate) === mostNegativeRate)?.symbol || 'N/A';
    console.log(chalk.red(`Most negative funding rate: ${(mostNegativeRate * 100).toFixed(4)}% (${mostNegativeSymbol})`));
}

// --- Main execution ---
console.log(chalk.blue.bold('===== Binance Futures Funding Rate Checker ====='));
console.log(chalk.gray('Running date: ' + new Date().toLocaleString()));
console.log(chalk.gray('API URL: ' + BINANCE_API_URL));

// Choose one method to execute:
getFundingRatesWithCurl();  // Using CURL
// getFundingRatesWithAxios(); // Using Axios

// Export the CURL command as a string for easy copying/pasting
const exportedCurlCommand = `curl -X GET "${BINANCE_API_URL}/fapi/v1/premiumIndex"`;
console.log(chalk.yellow('\nSimple CURL command to copy/paste in terminal:'));
console.log(exportedCurlCommand);