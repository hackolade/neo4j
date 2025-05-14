const os = require('os');
const net = require('net');
const packageFile = require('../package.json');

const checkConnection = (host, port, timeout = 5000) =>
	new Promise((resolve, reject) => {
		if (host.startsWith('neo4j')) {
			return resolve();
		}
		const timer = setTimeout(() => {
			socket.end();
			reject(new Error('Connection takes more than ' + 5000 + ' ms'));
		}, timeout);

		const socket = net.createConnection(port || 7687, host, () => {
			socket.end();
			clearTimeout(timer);
			resolve();
		});
		socket.on('error', err => {
			clearTimeout(timer);
			reject(err);
		});
		resolve();
	});

const logHelper = {
	checkConnection,
};

module.exports = logHelper;
