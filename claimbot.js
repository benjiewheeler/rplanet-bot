const axios = require("axios");
const { cyan, green, magenta, red, yellow } = require("chalk");
const { Api } = require("eosjs/dist/eosjs-api");
const { JsonRpc } = require("eosjs/dist/eosjs-jsonrpc");
const { JsSignatureProvider } = require("eosjs/dist/eosjs-jssig");
const { PrivateKey } = require("eosjs/dist/eosjs-key-conversions");
const { dateToTimePointSec, timePointSecToDate } = require("eosjs/dist/eosjs-serialize");
const _ = require("lodash");
const nodeFetch = require("node-fetch");
const { TextDecoder, TextEncoder } = require("util");

require("dotenv").config();

const fetch = (url, payload) =>
    nodeFetch(url, {
        ...payload,
        headers: { "User-Agent": "rplanetbot/1.0.0" },
    });

const WAX_ENDPOINTS = _.shuffle([
    "https://api.wax.greeneosio.com",
    "https://api.waxsweden.org",
    "https://wax.cryptolions.io",
    "https://wax.eu.eosamsterdam.net",
    "https://wax.greymass.com",
    "https://wax.pink.gg",
]);

const Configs = {
    WAXEndpoints: [...WAX_ENDPOINTS]
};

async function shuffleEndpoints() {
    // shuffle endpoints to avoid spamming a single one
    Configs.WAXEndpoints = _.shuffle(WAX_ENDPOINTS);
}

/**
 *
 * @param {number} t in seconds
 * @returns {Promise<void>}
 */
async function waitFor(t) {
    return new Promise(resolve => setTimeout(() => resolve(), t * 1e3));
}

function parseRemainingTime(millis) {
    const diff = Math.floor(millis / 1e3);
    const hours = Math.floor(diff / 3600);
    const minutes = Math.floor((diff % 3600) / 60);
    const seconds = Math.floor((diff % 3600) % 60);
    const time = [
        hours > 0 && `${hours.toString().padStart(2, "0")} hours`,
        minutes > 0 && `${minutes.toString().padStart(2, "0")} minutes`,
        seconds > 0 && `${seconds.toString().padStart(2, "0")} seconds`,
    ]
        .filter(n => !!n)
        .join(", ");

    return time;
}

function logTask(...message) {
    console.log(`${yellow("Task")}`, ...message);
    console.log("-".repeat(32));
}

async function transact(config) {
    const { DEV_MODE } = process.env;
    if (DEV_MODE == 1) {
        return;
    }

    try {
        const endpoint = _.sample(Configs.WAXEndpoints);
        const rpc = new JsonRpc(endpoint, { fetch });

        const accountAPI = new Api({
            rpc,
            signatureProvider: new JsSignatureProvider(config.privKeys),
            textEncoder: new TextEncoder(),
            textDecoder: new TextDecoder(),
        });

        const info = await rpc.get_info();
        const subId = info.head_block_id.substr(16, 8);
        const prefix = parseInt(subId.substr(6, 2) + subId.substr(4, 2) + subId.substr(2, 2) + subId.substr(0, 2), 16);

        const transaction = {
            expiration: timePointSecToDate(dateToTimePointSec(info.head_block_time) + 3600),
            ref_block_num: 65535 & info.head_block_num,
            ref_block_prefix: prefix,
            actions: await accountAPI.serializeActions(config.actions),
        };

        const abis = await accountAPI.getTransactionAbis(transaction);
        const serializedTransaction = accountAPI.serializeTransaction(transaction);

        const accountSignature = await accountAPI.signatureProvider.sign({
            chainId: info.chain_id,
            abis,
            requiredKeys: config.privKeys.map(pk => PrivateKey.fromString(pk).getPublicKey().toString()),
            serializedTransaction,
        });

        const pushArgs = { ...accountSignature };
        const result = await accountAPI.pushSignedTransaction(pushArgs);

        console.log(green(result.transaction_id));
    } catch (error) {
        console.log(red(error.message));
    }
}

async function fetchTable(contract, table, scope, bounds, tableIndex, index = 0) {
    if (index >= Configs.WAXEndpoints.length) {
        return [];
    }

    try {
        const endpoint = Configs.WAXEndpoints[index];
        const rpc = new JsonRpc(endpoint, { fetch });

        const data = await Promise.race([
            rpc.get_table_rows({
                json: true,
                code: contract,
                scope: scope,
                table: table,
                lower_bound: bounds,
                upper_bound: bounds,
                index_position: tableIndex,
                key_type: "i64",
                limit: 100,
            }),
            waitFor(5).then(() => null),
        ]);

        if (!data) {
            throw new Error();
        }

        return data.rows;
    } catch (error) {
        return await fetchTable(contract, table, scope, bounds, tableIndex, index + 1);
    }
}

async function fetchBalance(account, index = 0) {
    if (index >= Configs.WAXEndpoints.length) {
        return [];
    }

    try {
        const endpoint = Configs.WAXEndpoints[index];
        const rpc = new JsonRpc(endpoint, { fetch });

        const data = await Promise.race([
            rpc.get_currency_balance("e.rplanet", account, "AETHER"),
            waitFor(5).then(() => null),
        ]);

        if (!data) {
            throw new Error();
        }

        return parseFloat(data[0]);
    } catch (error) {
        return await fetchBalance(account, index + 1);
    }
}

async function fetchLimit(account) {
    return await fetchTable("s.rplanet", "claimlimits", "s.rplanet", account, 1);
}

async function fetchCollected(account, errorCount = 0) {
    try {
        const response = await axios.post(`https://rplanet.io/api/get_collected`,
            { account },
            { headers: { "content-type": "application/json" }, timeout: 5e3 }
        );

        return parseFloat(response.data.result);
    } catch (error) {
        if (errorCount > 3) {
            return NaN;
        }
        return await fetchCollected(account, errorCount + 1);
    }
}

function makeIncreaseAction(account, quantity) {
    return {
        account: "e.rplanet",
        name: "transfer",
        authorization: [{ actor: account, permission: "active" }],
        data: {
            from: account,
            to: "s.rplanet",
            quantity: `${quantity.toLocaleString("en", { useGrouping: false, minimumFractionDigits: 4, maximumFractionDigits: 4 })}`,
            memo: "extend claim limit"
        },
    };
}

function makeClaimAction(account) {
    return {
        account: "s.rplanet",
        name: "claim",
        authorization: [{ actor: account, permission: "active" }],
        data: { to: account },
    };
}

async function increaseLimit(account, privKey) {
    shuffleEndpoints();

    const { DELAY_MIN, DELAY_MAX, MAX_CLAIM_LIMIT } = process.env;
    const delayMin = parseFloat(DELAY_MIN) || 4;
    const delayMax = parseFloat(DELAY_MAX) || 10;
    const maxLimit = parseFloat(MAX_CLAIM_LIMIT) || 1e5;

    logTask(`Increasing Limit`);
    console.log(`Fetching account ${cyan(account)}`);
    const [accountLimit] = await fetchLimit(account);

    if (!accountLimit) {
        console.log(`${yellow("Warning")} Account ${cyan(account)} not found`);
    }

    const { limit, extended_at } = accountLimit || { limit: 1e4, extended_at: 0 };

    const collected = await fetchCollected(account);
    const now = Math.floor(Date.now() / 1e3);
    const hours = Math.floor((now - extended_at) / 3600);
    const currentLimit = Math.max(1e4, (limit / 1e4) * Math.pow(0.99, hours));

    if (currentLimit > collected) {
        console.log(
            `${yellow("Info")}`,
            `Account ${cyan(account)} doesn't need to increase limit`,
            `(collected ${yellow(_.round(collected).toLocaleString("en", { useGrouping: true }))} / ${yellow(_.round(currentLimit).toLocaleString("en", { useGrouping: true }))})`
        );
        return;
    }
    const MIN_LIMIT = 1e4;
    const MAX_LIMIT = 50e6;

    const targetLimit = Math.min(maxLimit, collected);
    const increaseCost = Math.ceil(Math.pow(MAX_LIMIT, 2) * (MIN_LIMIT - targetLimit) / (targetLimit - MAX_LIMIT) / (MAX_LIMIT - MIN_LIMIT));

    const aetherBalance = await fetchBalance(account);

    if (aetherBalance < increaseCost) {
        console.log(`${yellow("Warning")} Account ${cyan(account)} doesn't have enough aether to increase the limit`);
        return;
    }

    const delay = _.round(_.random(delayMin, delayMax, true), 2);
    console.log(
        `\tIncreasing limit to ${yellow(_.round(targetLimit).toLocaleString("en", { useGrouping: true }))}`,
        `by spending ${yellow(_.round(increaseCost).toLocaleString("en", { useGrouping: true }))} AETHER`,
        `(after a ${Math.round(delay)}s delay)`
    );
    const actions = [makeIncreaseAction(account, increaseCost)];

    await waitFor(delay);
    await transact({ account, privKeys: [privKey], actions });
}

async function claimAether(account, privKey) {
    shuffleEndpoints();

    const { DELAY_MIN, DELAY_MAX, MIN_CLAIM, MAX_WASTE } = process.env;
    const delayMin = parseFloat(DELAY_MIN) || 4;
    const delayMax = parseFloat(DELAY_MAX) || 10;
    const minClaim = parseFloat(MIN_CLAIM) || 50e3;
    const maxWaste = parseFloat(MAX_WASTE) || 1e3;

    logTask(`Claiming Aether`);
    console.log(`Fetching account ${cyan(account)}`);
    const [accountLimit] = await fetchLimit(account);

    if (!accountLimit) {
        console.log(`${yellow("Warning")} Account ${cyan(account)} not found`);
    }

    const { limit, extended_at } = accountLimit || { limit: 1e4, extended_at: 0 };

    const collected = await fetchCollected(account);

    if (minClaim > collected) {
        console.log(`${yellow("Warning")} Account ${cyan(account)} doesn't have enough aether to claim; aborting`);
        return;
    }

    const now = Math.floor(Date.now() / 1e3);
    const hours = Math.floor((now - extended_at) / 3600);
    const currentLimit = Math.max(1e4, (limit / 1e4) * Math.pow(0.99, hours));

    const waste = Math.max(0, collected - currentLimit);

    if (waste > maxWaste) {
        console.log(`${yellow("Warning")} Waste ${yellow(_.round(waste).toLocaleString("en", { useGrouping: true }))} exceeds max waste threshold ${yellow(_.round(maxWaste).toLocaleString("en", { useGrouping: true }))} `);
        return;
    }

    const delay = _.round(_.random(delayMin, delayMax, true), 2);

    console.log(
        `\tClaiming with`,
        `(${yellow(_.round(collected).toLocaleString("en", { useGrouping: true }))} AETHER)`,
        `Wasting (${yellow(_.round(waste).toLocaleString("en", { useGrouping: true }))} AETHER)`,
        `(after a ${Math.round(delay)}s delay)`
    );

    const actions = [makeClaimAction(account)];

    await waitFor(delay);
    await transact({ account, privKeys: [privKey], actions });

}

async function runTasks(account, privKey) {
    await increaseLimit(account, privKey);
    console.log(); // just for clarity

    await claimAether(account, privKey);
    console.log(); // just for clarity
}

async function runAccounts(accounts) {
    for (let i = 0; i < accounts.length; i++) {
        const { account, privKey } = accounts[i];
        await runTasks(account, privKey);
    }
}

(async () => {
    console.log(`R-Planet Bot initialization`);

    const accounts = Object.entries(process.env)
        .map(([k, v]) => {
            if (k.startsWith("ACCOUNT_NAME")) {
                const id = k.replace("ACCOUNT_NAME", "");
                const key = process.env[`PRIVATE_KEY${id}`];
                if (!key) {
                    console.log(red(`Account ${v} does not have a PRIVATE_KEY${id} in .env`));
                    return;
                }

                try {
                    // checking if key is valid
                    PrivateKey.fromString(key).toLegacyString();
                } catch (error) {
                    console.log(red(`PRIVATE_KEY${id} is not a valid EOS key`));
                    return;
                }

                return { account: v, privKey: key };
            }

            return null;
        })
        .filter(acc => !!acc);

    const { CHECK_INTERVAL } = process.env;
    const interval = parseInt(CHECK_INTERVAL) || 15;

    console.log(`R-Planet Bot running for ${accounts.map(acc => cyan(acc.account)).join(", ")}`);
    console.log(`Running every ${interval} minutes`);
    console.log();

    runAccounts(accounts);

    setInterval(() => runAccounts(accounts), interval * 60e3);
})();
