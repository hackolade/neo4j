const _ = require('lodash');
const neo4j = require('neo4j-driver').v1;
let driver;
let sshTunnel;
const fs = require('fs');
const ssh = require('tunnel-ssh');

const getSshConfig = (info) => {
	const config = {
		username: info.ssh_user,
		host: info.ssh_host,
		port: info.ssh_port,
		dstHost: info.host,
		dstPort: info.port,
		localHost: '127.0.0.1',
		localPort: info.port,
		keepAlive: true
	};

	if (info.ssh_method === 'privateKey') {
		return Object.assign({}, config, {
			privateKey: fs.readFileSync(info.ssh_key_file),
			passphrase: info.ssh_key_passphrase
		});
	} else {
		return Object.assign({}, config, {
			password: info.ssh_password
		});
	}
};

const connectViaSsh = (info, app) => new Promise((resolve, reject) => {
	ssh(getSshConfig(info), (err, tunnel) => {
		if (err) {
			reject(err);
		} else {
			resolve({
				tunnel,
				info: Object.assign({}, info, {
					host: '127.0.0.1'
				})
			});
		}
	});
});

const connectToInstance = (info) => {
	return new Promise((resolve, reject) => {
		const host = info.host;
		const port = info.port;
		const username = info.username;
		const password = info.password;
		const sslOptions = getSSLConfig(info);

		driver = neo4j.driver(`bolt://${host}:${port}`, neo4j.auth.basic(username, password), sslOptions);

		driver.onCompleted = () => {
			resolve();
		};

		driver.onError = (error) => {
			driver = null;
			reject(error);
		};
	});
};

const connect = (info, app) => {
	if (info.ssh) {
		return connectViaSsh(info, app)
			.then(({ info, tunnel }) => {
				sshTunnel = tunnel;

				return connectToInstance(info);
			});
	} else {
		return connectToInstance(info);
	}
};

const close = () => {
	if (driver) {
		driver.close();
		driver = null;
	}

	if (sshTunnel) {
		sshTunnel.close();
		sshTunnel = null;
	}
};

const execute = (command) => {
	return new Promise((resolve, reject) => {
		const db = driver.session();
		let result = [];
		db.run(command)
			.subscribe({
				onNext: (record) => {
					result.push(record.toObject());
				},
				onCompleted: () => {
					db.close();
					resolve(result);
				},
				onError: (error) => {
					db.close();
					reject(error);
				}
			});
	});
};

const castInteger = (properties) => {
	let result = Array.isArray(properties) ? [] : {};
	for (let prop in properties) {
		let value = properties[prop];
		if (neo4j.isInt(value)) {
			value = value.toInt();
		} else if (typeof value === 'object') {
			value = castInteger(value);
		}
		result[prop] = value;
	}
	return result;
};

const getLabels = () => {
	return execute('MATCH (n) RETURN DISTINCT labels(n) as label').then((data) => {
			let labels = [];
			data.forEach((record) => {
				labels = labels.concat(record.label);
			});
			return labels
		});
};

const getSchema = () => {
	return execute('CALL db.schema()').then(result => {
		const nodes = result[0].nodes;
		const relationships = result[0].relationships;
		let data = [];

		relationships.forEach(relationship => {
			let res = {
				start: '',
				relationship: relationship.type,
				end: ''
			};
			nodes.forEach(node => { 
				if (relationship.start.compare(node.identity) === 0) {
					res.start = node.labels[0];
				}
				if (relationship.end.compare(node.identity) === 0) {
					res.end = node.labels[0];
				}
			});
			data.push(res);
		});

		return data;
	});
};

const getDatabaseName = () => {
	return execute('call dbms.listConfig("active_database")').then(result => {
		return result[0].value;
	});
};

const getNodes = (label, limit = 100) => {
	return execute(`MATCH (row:\`${label}\`) RETURN row LIMIT ${limit}`)
		.then((result) => {
			return result.map(record => castInteger(record.row.properties));
		});
};

const getRelationshipData = (start, relationship, end, limit = 100) => {
	return execute(`MATCH (:\`${start}\`)-[row:\`${relationship}\`]-(:\`${end}\`) RETURN row LIMIT ${limit}`)
		.then((result) => {
			return result.map(record => castInteger(record.row.properties));
		});
};

const getNodesCount = (label) => {
	return execute(`MATCH (a:\`${label}\`) RETURN count(a) AS count`).then(result => castInteger(result[0]).count);
};

const getCountRelationshipsData = (start, relationship, end) => {
	return execute(`MATCH (:\`${start}\`)-[rel:\`${relationship}\`]-(:\`${end}\`) RETURN count(rel) AS count`).then(result => castInteger(result[0]).count);
};

const getIndexes = () => {
	return execute('CALL db.indexes()');
};

const getConstraints = () => {
	return execute('CALL db.constraints()');
};

const getSSLConfig = (info) => {
	let config = {
		encrypted: 'ENCRYPTION_ON',
		trust: info.sslType
	};

	switch(info.sslType) {
		case "TRUST_ALL_CERTIFICATES":
		case "TRUST_SYSTEM_CA_SIGNED_CERTIFICATES":
			return config;
		case "TRUST_CUSTOM_CA_SIGNED_CERTIFICATES":
			config.trustedCertificates = [info.certAuthority];
			return config;
		case "TRUST_SERVER_CLIENT_CERTIFICATES":
			config.trustedCertificates = [info.certAuthority];
			config.key = info.clientPrivateKey;
			config.cert = info.clientCert;
			config.passphrase = info.passphrase;
			return config;
		case "Off":
		default: 
			return {};
	}
};

const checkConnection = () => {
	return driver._connectionProvider.acquireConnection().then(conn => {
		return driver._validateConnection(conn);
	});
}

module.exports = {
	checkConnection,
	connect,
	close,
	getLabels,
	getRelationshipData,
	getSchema,
	getDatabaseName,
	getNodes,
	getNodesCount,
	getCountRelationshipsData,
	getIndexes,
	getConstraints
};
