const prompt = require('./prompt');

const bip39 = require('bip39');
const scrypt = require('scrypt-async');
const AES = require("aes-oop").default;
const Scatter = require('@walletpack/core/models/Scatter').default;
const Error = require('@walletpack/core/models/errors/Error').default;
const IdGenerator = require('@walletpack/core/util/IdGenerator').default;
const Hasher = require('@walletpack/core/util/Hasher').default;

require('@walletpack/core/services/utility/Framework').default.init({
	getVersion:() => require('../../package').version,
});

const plugins = {
	eos:new (require('@walletpack/eosio').default)(),
	trx:new (require('@walletpack/tron').default)(),
	btc:new (require('@walletpack/bitcoin').default)(),
	eth:new (require('@walletpack/ethereum').default)()
}


let seed, salt, scatter, storage;

// Storage is not set by default, this allows
// changing the storage mechanism for testing purposes.
const setStorage = _s => storage = _s;

const init = async () => {
	scatter = await storage.getScatter();
	salt = await storage.getSalt();
	storage.getSeedSetter(() => seed);
}


const setScatter = (_s) => scatter = JSON.parse(JSON.stringify(_s));
const getScatter = () => scatter ? JSON.parse(JSON.stringify(scatter)) : null;

const exists = () => !!scatter;

const isEncrypted = x => x.toString().indexOf('"iv":') > -1;
const isUnlocked = () => !!seed && !isEncrypted(scatter);

const updateScatter = async (_s) => {
	if(exists() && !isUnlocked()) return;

	_s.keychain.keypairs.map(x => {
		if(!isEncrypted(x.privateKey)){
			x.privateKey = AES.encrypt(Buffer.from(x.privateKey), seed);
		}
	})

	_s.keychain.identities.map(x => {
		if(!isEncrypted(x.privateKey)){
			x.privateKey = AES.encrypt(Buffer.from(x.privateKey), seed);
		}
	})

	_s.keychain.cards.map(x => {
		if(!isEncrypted(x.secure)){
			x.secure = AES.encrypt(x.secure, seed);
		}
	});

	scatter = Scatter.fromJson(JSON.parse(JSON.stringify(_s)));

	_s.keychain = AES.encrypt(_s.keychain, seed);
	await storage.setScatter(AES.encrypt(_s, seed));
	return getScatter();
}

const verifyPassword = async password => {
	const hash = await passwordToSeed(password);
	return seed === hash;
}

const changePassword = async (newPassword) => {
	const oldSalt = await storage.getSalt();
	const oldSeed = seed;

	const newSalt = Hasher.unsaltedQuickHash(IdGenerator.text(32));
	await storage.setSalt(newSalt);

	const newSeed = await passwordToSeed(newPassword);
	seed = newSeed;

	const clone = JSON.parse(JSON.stringify(scatter));
	clone.keychain.keypairs.map(keypair => {
		keypair.privateKey = AES.decrypt(keypair.privateKey, oldSeed);
		keypair.privateKey = AES.encrypt(keypair.privateKey, newSeed);
	});
	clone.keychain.identities.map(id => {
		id.privateKey = AES.decrypt(id.privateKey, oldSeed);
		id.privateKey = AES.encrypt(id.privateKey, newSeed);
	});

	await updateScatter(clone);

	await storage.reencryptOptionals(oldSeed, newSeed);
	return true;
}




const hashPassword = (password) => {
	return new Promise(async resolve => {
		salt = await storage.getSalt();
		scrypt(password, salt, {
			N: 16384,
			r: 8,
			p: 1,
			dkLen: 16,
			encoding: 'hex'
		}, (derivedKey) => {
			resolve(derivedKey);
		})
	});
}

const passwordToSeed = async password => {
	const hash = await hashPassword(password);
	let mnemonic = bip39.entropyToMnemonic(hash);
	return bip39.mnemonicToSeedHex(mnemonic);
}


const reloading = async () => {
	if(seed) seed = null;
	if(scatter) scatter = await storage.getScatter();
};

const getPrivateKey = async (keypairId, blockchain) => {
	if(!await prompt.accepted(
		`Exporting a private key.`,
		`Something has requested a private key. Are you currently exporting the private key from Scatter?`
	)) return null;

	return getPrivateKeyForSigning(keypairId, blockchain);
}

const getPrivateKeyForSigning = async (keypairId, blockchain) => {
	let keypair = scatter.keychain.keypairs.find(x => x.id === keypairId);
	if(!keypair) return;

	const encryptedKey = JSON.parse(JSON.stringify(keypair.privateKey));
	const decryptedKey = AES.decrypt(encryptedKey, seed);

	return plugins[blockchain].bufferToHexPrivate(decryptedKey);
}

const lock = async () => {
	seed = null;
	scatter = await storage.getScatter();
	return true;
}

const forceSalt = async _salt => {
	await storage.setSalt(_salt);
	salt = _salt;
	return true;
}

const unlock = async (password, isNew = false, _salt = null) => {
	if(isUnlocked()) return getScatter();

	try {
		if(_salt) await forceSalt(_salt);
		if(!salt) await forceSalt(Hasher.unsaltedQuickHash(IdGenerator.text(32)));

		seed = await passwordToSeed(password);

		if(!isNew) {
			let decrypted = AES.decrypt(scatter, seed);
			if (!decrypted.hasOwnProperty('keychain')) return false;
			decrypted = Scatter.fromJson(decrypted);
			decrypted.decrypt(seed);
			scatter = decrypted;
		}

		return getScatter();
	} catch(e){
		console.error('decrypt error', e);
		seed = null;
		scatter = await storage.getScatter();
		return false;
	}
}

const sign = async (network, publicKey, payload, arbitrary = false, isHash = false) => {
	try {

		const plugin = plugins[network.blockchain];
		if(!plugin) return false;

		const keypair = scatter.keychain.keypairs.find(x => x.publicKeys.find(k => k.key === publicKey))
		if(!keypair) return Error.signatureError('no_keypair', 'This keypair could not be found');

		if(keypair.external) return signWithHardware(keypair, network, publicKey, payload, arbitrary, isHash);

		const privateKey = await getPrivateKeyForSigning(keypair.id, network.blockchain);

		return plugin.signer(payload, publicKey, arbitrary, isHash, privateKey);
	} catch(e){
		console.error('Signing Error!', e);
		return Error.signatureError('sign_err', 'There was an error signing this transaction.');
	}
};






const hardwareTypes = []

const getHardwareKey = async (blockchain, index) => {
	return console.error(`Extensions don't support getHardwareKey`);
};

const signWithHardware = async (keypair, network, publicKey, payload, arbitrary = false, isHash = false) => {
	return console.error(`Extensions don't support signWithHardware`);
}

const encrypt = data => AES.encrypt(data, seed);
const decrypt = data => AES.decrypt(data, seed);

const getSeed = () => seed;

const availableBlockchains = () => ({
	EOSIO:'eos',
	ETH:'eth',
	TRX:'trx',
	BTC:'btc',
});

module.exports = {
	setStorage,
	init,
	exists,
	updateScatter,
	setScatter,
	getScatter,
	sign,
	getPrivateKey,
	reloading,
	isUnlocked,
	unlock,
	lock,
	verifyPassword,
	changePassword,
	hardwareTypes,
	getHardwareKey,
	encrypt,
	decrypt,

	getSeed,
	availableBlockchains,
}
