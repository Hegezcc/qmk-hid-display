#!/usr/bin/env node
"use strict";

const hid = require("node-hid");
const os = require("os");
const osu = require("node-os-utils");
const request = require("request");
const batteryLevel = require("battery-level");
const loudness = require("loudness");

const config = require("./config.json");

// the node-audio-windows version is much faster on windows, but loudness handles other os's better, so let's get the best of both worlds
let winAudio;
try {
  winAudio = require("node-audio-windows").volume;
} catch (err) {
  // do nothing
}

// Keyboard info
const KEYBOARD_NAME = "Kyria Keyboard";
const KEYBOARD_USAGE_ID = 0x61;
const KEYBOARD_USAGE_PAGE = 0xff60;

const KEYBOARD_UPDATE_TIME = 1000;
const STOCK_UPDATE_TIME = 60000;
const STOCK_BACKGROUND_TIME = STOCK_UPDATE_TIME * 30;
const WEATHER_UPDATE_TIME = 60000;
const WEATHER_BACKGROUND_TIME = WEATHER_UPDATE_TIME * 10;
const PERF_UPDATE_TIME = KEYBOARD_UPDATE_TIME;
const PERF_BACKGROUND_TIME = PERF_UPDATE_TIME * 10;

// Info screen types
const SCREEN_PERF = 1;
const SCREEN_STOCK = 2;
const SCREEN_WEATHER = 3;

const screens = [null, (w, h) => "", (w, h) => "", (w, h) => ""];
const stocks = new Map();
let currentScreenIndex = 0;
let screenWidth = 0;
let screenHeight = 0;

let keyboard = null;
let screenBuffer = null;
let screenLastUpdate = null;
let timer = null;

const last_updates = {};
last_updates[SCREEN_PERF] = 0;
last_updates[SCREEN_STOCK] = 0;
last_updates[SCREEN_WEATHER] = 0;


// Helper function to wait a few milliseconds using a promise
function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getPerfs() {
  console.log('Updating perf data...');
  
  try {
    const [
      user,
      host,
      cpuUsagePercent,
      usedMemoryPercent,
      volumeLevelPercent,
      batteryPercent,
    ] = await Promise.all([
      os.userInfo().username,
      osu.os.hostname(),
      osu.cpu.usage(),
      osu.mem.info().then(mem => mem.usedMemPercentage),
      osu.os.platform() === "darwin" || winAudio === undefined
        ? loudness.getVolume()
        : winAudio.getVolume() * 100,
      (await batteryLevel()) * 100,
      
    ]);

    const lines = [
      `${user} @ ${host}`
    ];

    const stats = [];

    if (cpuUsagePercent || cpuUsagePercent === 0) stats.push(["CPU:", cpuUsagePercent]);
    if (usedMemoryPercent || usedMemoryPercent === 0) stats.push(["RAM:", usedMemoryPercent]);
    if (volumeLevelPercent || volumeLevelPercent === 0) stats.push(["VOL:", volumeLevelPercent]);
    if (batteryPercent || batteryPercent === 0) stats.push(["BAT:", batteryPercent]);

    const maxTitleSize = Math.max(...stats.map(([header]) => header.length));

    // Set this to be the latest performance info
    screens[SCREEN_PERF] = (w, h) => 
      lines.concat(stats
        .map(([header, percent], index) => {
          const barGraphSize = w - maxTitleSize;
          const numBlackTiles = barGraphSize * (percent / 100);
          return `${header} ${"\u0008".repeat(
            Math.ceil(numBlackTiles)
          )}`;
        }))
      .map(line => line.padEnd(w, ' ').slice(0, w))
      .slice(0, h)
      .join("");
    
    // Also update the timestamp of last update; this is also updated before running
    last_updates[SCREEN_PERF] = Date.now();

    console.log('Perf data updated!');
  } catch (e) {
    console.log(`Error when updating perf data: ${e}`)
  }
}

function matchStockKey(key, test) {
  return RegExp(`^(?:\\d*\\. )?${test}\$`).test(key);
}

function getStockKey(stock) {
  if (stock['function'] === 'GLOBAL_QUOTE') {
    return stock['symbol'];
  } else if (stock['function'] === 'CURRENCY_EXCHANGE_RATE') {
    return stock['from_currency'];
  } else {
    console.log(`Unknown stock: ${stock}`);
    return null;
  }
}

function getStockValue(stock, resp) {
  if (resp['Note']) console.log(`Stock note: ${resp['Note']}`);

  try {
    let dir = ' ';
    let unit = stock['unit'];
    let price = '???';

    if (stock['function'] === 'GLOBAL_QUOTE') {
      for (let key in resp['Global Quote']) {
        if (matchStockKey(key, 'price')) {
          price = parseFloat(resp['Global Quote'][key]);
          break;
        }
      }
    } else if (stock['function'] === 'CURRENCY_EXCHANGE_RATE') {
      for (let key in resp['Realtime Currency Exchange Rate']) {
        if (matchStockKey(key, 'Exchange Rate')) {
          price = parseFloat(resp['Realtime Currency Exchange Rate'][key]);
          break;
        }
      }
    } else {
      console.log(`Unknown stock: ${stock}, resp: ${resp}`);
    }

    let oldPrice = stocks.get(getStockKey(stock));
    console.log(oldPrice);

    // If oldPrice is undefined or zero, we don't have the change information
    if (oldPrice) {
      oldPrice = /\d+\.\d+/.exec(oldPrice);

      // Now it should have a match
      if (oldPrice && oldPrice.length > 0) {
        dir = oldPrice[0] > price ? "\u001e" : "\u001f";
      }
    }

    return `${dir} ${unit}${price}`;
  
  } catch (e) {
    console.log(`Stock parsing error: ${e}`);
    return 'Error'
  }
}

for (let stock of config['stocks']) {
  stocks.set(getStockKey(stock), '???');
}

async function getStocks() {
  console.log('Updating stock data...');
  
  try {
    const promises = [];
    for (let stock of config['stocks']) {
      promises.push(
        new Promise((resolve) => {
          let url = 'https://www.alphavantage.co/query?';
          url += Object.keys(stock).map(k => `${escape(k)}=${escape(stock[k])}`).join('&');
          url += `&apikey=${escape(config['alphavantage_key'])}`;

          // Get the stock price page for the current stock
          request(
            url,
            (err, res, body) => {
              // Parse out the price and update the map
              const key = getStockKey(stock);
              const value = getStockValue(stock, JSON.parse(body));
              console.log(key, value);
              stocks.set(key, value);
              resolve();
            }
          );
        })
      );
    }

    // Wait for all the stocks to be updated
    await Promise.all(promises);

    // Create a screen using the stock data
    const lines = [];
    const maxTitleSize = Math.max(...[...stocks.keys()].map(key => key.length));

    for (const [key, value] of stocks) {
      lines.push(`${key.padEnd(maxTitleSize)} ${value}`);
    }

    // Set this to be the latest stock info
    screens[SCREEN_STOCK] = (w, h) => lines
      .map(line => line.padEnd(w, ' ').slice(0, w))
      .slice(0, h)
      .join("");

    // Also update the timestamp of last update; this is also updated before running
    last_updates[SCREEN_STOCK] = Date.now();

    console.log('Stock data updated!');
  } catch (e) {
    console.log(`Error when updating stock data: ${e}`)
  }
}

let lastWeather = null;
let lastWeatherDescIndex = 0;

async function getWeather() {
  console.log('Updating weather data...');
  
  try {
    // Used for scrolling long weather descriptions
    // Get the current weather for Seattle
    const weather = await (new Promise((resolve) => {
      request(
        `https://api.openweathermap.org/data/2.5/weather?q=${config['weather_city']}&appid=${config['openweathermap_key']}`,
        (err, res, body) => {
          const data = JSON.parse(body);
          const kelvin = 273.15;

          const weather = [
            ['city', `${data['name']} ${data['sys']['country']}`],
            ['desc', data['weather'][0]['description']],
            ['temp', `${(data['main']['temp'] - kelvin).toFixed(1)}C`],
          ];

          if (data['rain']) weather.push(['rain', `${data['rain']['3h']}mm`]);
          if (data['snow']) weather.push(['snow', `${data['snow']['3h']}mm`]);
          if (data['wind']) {
            let direction = '';
            const deg = data['wind']['deg'] % 360;

            if (deg > 292.5 || deg <= 67.5) direction += 'N';
            else if (deg > 112.5 && deg < 247.5) direction += 'S';

            if (deg > 22.5 && deg < 157.5) direction += 'E';
            else if (deg > 202.5 && 337.5) direction += 'W';

            weather.push(['wind', `${data['wind']['speed']}m/s ${direction}`])
          };

          resolve(weather);
        }
      );
    }));

    // Create the new screen
    screens[SCREEN_WEATHER] = (w, h) => {
      if (weather[1][1]) {
        let description = weather[1][1];
        const maxLen =  screenWidth - weather[1][0].length - 2;

        // If we are trying to show the same weather description more than once, and it is longer than 9
        // Which is all that will fit in our space, lets scroll it.
        if (
          lastWeather &&
          weather[1][1] == lastWeather[1][1] &&
          weather[1][1].length > maxLen
        ) {
          // Move the string one character over
          lastWeatherDescIndex++;
          description = description.slice(
            lastWeatherDescIndex,
            lastWeatherDescIndex + maxLen
          );
          if (lastWeatherDescIndex > weather[1][1].length - maxLen) {
            // Restart back at the beginning
            lastWeatherDescIndex = -1; // minus one since we increment before we show
          }
        } else {
          lastWeatherDescIndex = 0;
        }
      }

      lastWeather = weather;
      
      return weather
        .map(line => `${line[0]}: ${line[1]}`.padEnd(w, ' ').slice(0, w))
        .slice(0, h)
        .join("");

      // Also update the timestamp of last update; this is also updated before running
      last_updates[SCREEN_WEATHER] = Date.now();
      console.log('Weather data updated!');
    };
  } catch (e) {
    console.log(`Error when updating weather data: ${e}`)
  }
}

async function sendToKeyboard(func) {
  // Draw screen with keyboard info
  const screen = func(screenWidth, screenHeight);

  // If we are already buffering a screen to the keyboard just quit early.
  // Or if there is no update from what we sent last time.
  if (screenBuffer || screenLastUpdate === screen) {
    return; 
  }

  console.log(screen);

  screenLastUpdate = screen;

  // Convert the screen string into raw bytes
  screenBuffer = [];
  for (let i = 0; i < screenHeight * screenWidth; i++) {
    if (i >= screen.length - 1) {
      screenBuffer.push(' '.charCodeAt(0));
    } else {
      screenBuffer.push(screen.charCodeAt(i));
    }
  }

  // Split the bytes into chunks that we will send one at a time
  // This is to prevent hitting the 32 length limit on the connection
  const lines = [];
  const chunkSize = 31;
  let packetType = 2;
  for (let i = 0; i < screenBuffer.length; i += chunkSize - 1) {
    // For first chunk, we send the first byte as 2. For any following chunks, the first byte is 3. 
    // Also node-hid will eat the actual first byte, so set it as 0.
    lines.push([0, packetType].concat(screenBuffer.slice(i, Math.min(i + chunkSize - 1, screenBuffer.length))));
    packetType = 3;
  }

  //console.log(lines.map(line => line.length).join(' '), '=', lines.reduce((a, b) => a + b.length, 0));

  // Loop through and send each line after a small delay to allow the
  // keyboard to store it ready to send to the slave side once full.
  let index = 0;
  for (const line of lines) {
    if (osu.os.platform() === "darwin") {
      await wait(100);
    }
    keyboard.write(line);
    //console.log('[' + line.map(c => String.fromCharCode(c)).join('') + ']')
    if (osu.os.platform() === "darwin") {
      await wait(100);
    } else {
      await wait(20);
    }
  }

  // We have sent the screen data, so clear it ready for the next one
  screenBuffer = null;
}

function updateKeyboardScreen() {
  // Check what screens we have to update. If screen is active, update it more frequently than a screen in background.
  const now = Date.now();

  if ((currentScreenIndex === SCREEN_PERF && (last_updates[SCREEN_PERF] + PERF_UPDATE_TIME <= now)) || (last_updates[SCREEN_PERF] + PERF_BACKGROUND_TIME <= now)) {
    getPerfs();
    last_updates[SCREEN_PERF] = now;
  }
  if ((currentScreenIndex === SCREEN_STOCK && (last_updates[SCREEN_STOCK] + STOCK_UPDATE_TIME <= now)) || (last_updates[SCREEN_STOCK] + STOCK_BACKGROUND_TIME <= now)) {
    getStocks();
    last_updates[SCREEN_STOCK] = now;
  }
  if ((currentScreenIndex === SCREEN_WEATHER && (last_updates[SCREEN_WEATHER] + WEATHER_UPDATE_TIME <= now)) || (last_updates[SCREEN_WEATHER] + WEATHER_BACKGROUND_TIME <= now)) {
    getWeather();
    last_updates[SCREEN_WEATHER] = now;
  }

  // If we don't have a connection to a keyboard yet, look now
  if (!keyboard) {
    // Search all devices for a matching keyboard
    const devices = hid.devices();
    for (const d of devices) {
      if (
        d.product === KEYBOARD_NAME &&
        d.usage === KEYBOARD_USAGE_ID &&
        d.usagePage === KEYBOARD_USAGE_PAGE
      ) {
        // Create a new connection and store it as the keyboard
        keyboard = new hid.HID(d.path);
        console.log(`Keyboard connection established: ${KEYBOARD_NAME}`);

        keyboard.on("error", (error) => {
          console.log(`Keyboard error, resetting. ${error}`);
          keyboard = null;
        })

        // Listen for data from the keyboard which indicates the screen to show
        keyboard.on("data", (data) => {
          // Check that the data is a valid screen index and update the current one
          if (data[0] == 1 && data[1] <= screens.length - 1) {
            currentScreenIndex = data[1];
            screenWidth = data[2];
            screenHeight = data[3];

            console.log(`Keyboard requested screen index: ${currentScreenIndex}, w=${screenWidth}, h=${screenHeight}`);
            
            triggerUpdate();
          }
        });

        // On the initial connection write our special sequence
        // 1st byte - unused and thrown away on windows see bug in node-hid
        // 2nd byte - 1 to indicate a new connection
        // 3rd byte - number of screens the keyboard can scroll through
        keyboard.write([0, 1, screens.length]);
        break;
      }
    }
  }

  // If we have a connection to a keyboard and a valid screen
  if (keyboard && screens[currentScreenIndex]) {
    try {
      // Send that data to the keyboard
      sendToKeyboard(screens[currentScreenIndex]);
    } catch (error) {
      console.log(`Error trying to send data to keyboard: ${error}`);
      keyboard = null;
    }
  }
}

function triggerUpdate() {
  if (timer !== null) {
    clearInterval(timer);
  }

  updateKeyboardScreen();

  // Update the data on the keyboard with the current info screen every second
  timer = setInterval(updateKeyboardScreen, KEYBOARD_UPDATE_TIME);
}

triggerUpdate();