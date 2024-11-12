#!/usr/bin/env node

/**
 * To run:
 * - `npm install viem postgres`
 * - `DATABASE_URL=<dbURL> ISOLATION_LEVEL="read committed" PER_WALLET=10 WALLETS=100 node testSequence`
 */

const postgres = require('postgres');
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');

const isolationLevel = process.env.ISOLATION_LEVEL || `read committed`;
const pgsql = postgres(process.env.DATABASE_URL || 'postgres://postgres:password@0.0.0.0:5432/app', {
  max: 10,
});
const PER_WALLET = +(process.env.PER_WALLET || 10);
const WALLETS = +(process.env.WALLETS || 10);

const setup = async () => {
	await pgsql`create table if not exists next_nonce(wallet text primary key, num int default 1);`;
	await pgsql`create or replace function next_nonce(wallet text) returns int as $$
		insert into next_nonce as tab (wallet)
		values(next_nonce.wallet)
		on conflict (wallet) do
		update set num=tab.num+1
		returning tab.num;
		$$ language sql;`;
	await pgsql`create table if not exists blockchain_writes (primary key(wallet, num), wallet text, num int);`;
}

const updateAsCounter = async (address) => {
	return pgsql.begin(`transaction isolation level ${isolationLevel}`, async (sql) => {
		const [x] = await sql`insert into blockchain_writes
												select ${address}, next_nonce(${address})
												returning num;`;
		return x.num;
	})
}

const createWallet = async () => {
  const newMnemonic = generatePrivateKey();
  const address = privateKeyToAccount(newMnemonic).address;
  return { address, mnemonic: newMnemonic };
};

const getNewSequence = async (fn, address) => {
	return fn(address);
};

async function main() {
	await setup();
	const addressMap = [];
	for (let i = 0; i < WALLETS; i++) {
		const { address, mnemonic } = await createWallet();
		addressMap.push({ address, mnemonic });
		console.log(`Wallet ${address} created with mnemonic: ${mnemonic}`);
	}
	const arrays = new Array(WALLETS);
	for (let i = 0; i < WALLETS; i++) {
		arrays[i] = [];
		for (let j = 0; j < PER_WALLET; j++) {
			const current = addressMap[i];
			arrays[i].push(() => getNewSequence(updateAsCounter, current.address).catch((err) => {
				console.error(err);
				return -1;
			}));
		}
		console.log('Pushed promises for wallet', addressMap[i].address);
	}
	console.time("txs");
	const results = Promise.all(arrays.map((array) => {
		return Promise.all(array.map(fn => fn()));
	}));
	return results;
}

main()
	.then((results) => {
		console.timeEnd("txs");
		const output = [];
		for (let i = 0; i < WALLETS; i++) {
			output[i] = [];
			const current = results[i].sort((a, b) => a - b);
			for (let j = 0; j < PER_WALLET; j++) {
				if (current[j] === -1) {
					output[i].push('ERR');
				} else if (current[j] != j + 1) {
					output[i].push(`GAP (${j+1}/${current[j]})`);
				} else {
					output[i].push(current[j]);
				}
			}
			const consolidated = output[i].join('->');
			output[i] = consolidated;
		}
		return output;
	})
	.then((output) => {
		console.log(output);
		return output;
	})
	.then((output) => {
		output.forEach((line, index) => {
			const status = (line.includes('GAP') || line.includes('ERR')) ? 'FAILED' : 'PASSED';
			console[status === 'PASSED' ? 'log' : 'error'](`Wallet ${index+1}: ${status}`);
		});
	})
	.catch(console.error)
	.then(() => process.exit());
