const neo4j = require('@hackolade/neo4j-driver');
let driver;
let sshTunnel;
const fs = require('fs');
const ssh = require('tunnel-ssh');
let _;

const EXECUTE_TIME_OUT_CODE  = 'EXECUTE_TIME_OUT';
let timeout;

const setDependencies = ({ lodash }) => _ = lodash;
const setTimeOut = (data) => timeout = data?.queryRequestTimeout || 300000;

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

const connectViaSsh = (info) => new Promise((resolve, reject) => {
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
	}).on('error', console.error);
});

const connectToInstance = (info, checkConnection) => {
	return checkConnection(info.host, info.port)
	.then(() => new Promise((resolve, reject) => {
		const host = info.host;
		const port = info.port;
		const username = info.username;
		const password = info.password;
		const sslOptions = getSSLConfig(info);
		const driverConfig = {
			...sslOptions,
			maxConnectionPoolSize: 500,
			connectionAcquisitionTimeout: 2 * 60 * 1000
		};
		driver = neo4j.driver(`bolt://${host}:${port}`, neo4j.auth.basic(username, password), driverConfig);

		driver.verifyConnectivity()
			.then(() => {
				resolve();
			})
			.catch(error => {
				driver = null;
				reject(error);
			})
	}));
};

const connect = async (info, checkConnection) => {
	try {
		if (info.ssh) {
			return await connectViaSsh(info)
				.then(({ info, tunnel }) => {
					sshTunnel = tunnel;
	
					return connectToInstance(info, checkConnection);
				});
		} else {
			return await connectToInstance(info, checkConnection);
		}
	} catch (error) {
		error.step = 'Connection Error';
		throw error;
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

const execute = async (command, database = undefined, isMultiDb = false) => {
	if (!isMultiDb) {
		database = undefined;
	}
	const executeTimeout = new Promise((_, reject) => setTimeout(() => reject(getExecuteTimeoutError(timeout)), timeout));
	let result = [];
	let db;
	try {
		db = driver.session({ database });
		const executeWithOutTimeout = new Promise((resolve, reject) => {
			db.run(command)
				.subscribe({
					onNext: (record) => {
						result.push(record.toObject());
					},
					onCompleted: () => {
						db.close();
						db = null;
						resolve(result);
					},
					onError: (error) => {
						db.close();
						db = null;
						reject(error);
					}
				});
		});
		return await Promise.race([executeWithOutTimeout, executeTimeout]);
	} catch (error) {
		if (error.code === EXECUTE_TIME_OUT_CODE && db) {
			db.close();
		}
		throw error;
	}
};

const getExecuteTimeoutError = (timeout) => {
	const error = new Error(`execute timeout: ${timeout}ms exceeded`);
	error.code = EXECUTE_TIME_OUT_CODE;
	return error
}

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

const getLabels = async (database, isMultiDb) => {
	try {
		const labels = await execute('MATCH (n) RETURN DISTINCT labels(n) as label', database, isMultiDb).then((data) => {
			let labels = [];
			data.forEach((record) => {
				labels = labels.concat(record.label);
			});
			return labels
		});
		return labels;
	} catch (error) {
		error.step = error.step || 'Error of retrieving labels';
		throw error;
	}
};

const getSchema = (dbName, labels, isMultiDb) => {
	return execute(`call apoc.meta.subGraph({labels: ["${labels.join('","')}]})`, dbName, isMultiDb)
	.then(
		result => result,
		(error) => {
			if (error?.code === EXECUTE_TIME_OUT_CODE) {
				throw error;
			}	
			return execute('CALL db.schema.visualization()', dbName, isMultiDb)
		}
	)
	.then(result => {
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

const getDatabaseName = async (defaultDbName, isMultiDb) => {
	try {
		if (isMultiDb) {
			return await getActiveMultiDbsNames();
		} else {
			return await execute('call dbms.listConfig("active_database")').then(result => {
				return [_.get(result[0], 'value', defaultDbName)];
			}, () => {
				return [defaultDbName];
			});
		}
	} catch (error) {
		error.step = error.step || 'Error of retrieving database name';
	}
};

const supportsMultiDb = () => {
	return driver.supportsMultiDb();
}

const getActiveMultiDbsNames = async () => {
	const databases = await execute('SHOW DATABASES', 'system', true);
	return databases.filter(({ name, currentStatus }) => {
		return name !== 'system' && currentStatus === 'online';
	}).map(({ name }) => name);
}

const getNodes = (label, limit = 100, dbName, isMultiDb) => {
	return execute(`MATCH (row:\`${label}\`) RETURN row LIMIT ${limit}`, dbName, isMultiDb)
		.then((result) => {
			return result.map(record => castInteger(record.row.properties));
		});
};

const getRelationshipData = (start, relationship, end, limit = 100, dbName, isMultiDb) => {
	return execute(`MATCH (:\`${start}\`)-[row:\`${relationship}\`]-(:\`${end}\`) RETURN row LIMIT ${limit}`, dbName, isMultiDb)
		.then((result) => {
			return result.map(record => castInteger(record.row.properties));
		});
};

const getNodesCount = (label, dbName, isMultiDb) => {
	return execute(`MATCH (a:\`${label}\`) RETURN count(a) AS count`, dbName, isMultiDb).then(result => castInteger(result[0]).count);
};

const getCountRelationshipsData = (start, relationship, end, dbName, isMultiDb) => {
	return execute(`MATCH (:\`${start}\`)-[rel:\`${relationship}\`]-(:\`${end}\`) RETURN count(rel) AS count`, dbName, isMultiDb).then(
		result => castInteger(result[0]).count
	);
};

const getIndexes = (dbName, isMultiDb) => {
	return execute('CALL db.indexes()', dbName, isMultiDb);
};

const getConstraints = (dbName, isMultiDb) => {
	return execute('CALL db.constraints()', dbName, isMultiDb);
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

const getDbVersion = async () => {
	try {
		const versionResponse = await execute('call dbms.components() yield versions unwind versions as version return version');
		const version = _.get(versionResponse, '[0].version');
		const splittedVersion = version.split('.');
		if (splittedVersion[0] === '4' && splittedVersion[1] >= '3') {
			return '4.3';
		} else if (version.startsWith('4')) {
			return '4.0-4.2';
		}
		return '3.x'
	} catch (err) {
		return '3.x';
	}
}

const checkConnection = () => {
	return driver._connectionProvider.acquireConnection().then(conn => {
		return driver._validateConnection(conn);
	});
}

const isTemporalTypeField = field => {
	return (
		isDate(field) ||
		isDateTime(field) ||
		isDuration(field) ||
		isLocalDateTime(field) ||
		isLocalTime(field) ||
		isTime(field)
	);
}

const getTemporalFieldSchema = (field) => {
	const getFieldProps = mode => ({
		type: 'string',
		childType: 'temporal',
		mode,
	});

	switch (true) {
		case isDate(field):
			return getFieldProps('date');
		case isDateTime(field):
			return getFieldProps('datetime');
		case isDuration(field):
			return getFieldProps('duration');
		case isLocalDateTime(field):
			return getFieldProps('localdatetime');
		case isLocalTime(field):
			return getFieldProps('localtime');
		case isTime(field):
			return getFieldProps('time');
	}
}

const isDate = (filed) => {
	const keys = ['year', 'month', 'day', 'toString'];
	return isTemporalField(keys, filed);
}
const isDateTime = (filed) => {
	const keys = [
		'year',
		'month',
		'day',
		'hour',
		'minute',
		'second',
		'nanosecond',
		'timeZoneOffsetSeconds',
		'timeZoneId',
		'toString',
	];
	return isTemporalField(keys, filed);
}
const isDuration = (filed) => {
	const keys = [
		'months',
		'days',
		'seconds',
		'nanoseconds',
		'toString',
	];
	return isTemporalField(keys, filed);
}
const isLocalDateTime = (filed) => {
	const keys = [
		'year',
		'month',
		'day',
		'hour',
		'minute',
		'second',
		'nanosecond',
		'toString',
	];
	return isTemporalField(keys, filed);
}
const isLocalTime = (filed) => {
	const keys = [
		'hour',
		'minute',
		'second',
		'nanosecond',
		'toString',
	];
	return isTemporalField(keys, filed);
}
const isTime = (filed) => {
	const keys = [
		'hour',
		'minute',
		'second',
		'nanosecond',
		'timeZoneOffsetSeconds',
		'toString',
	];
	return isTemporalField(keys, filed);
}

const isTemporalField = (temporalFieldFormatKeys, field) => {
	const fieldKeys = Object.keys(field);
	return fieldKeys.length === temporalFieldFormatKeys.length && _.intersection(temporalFieldFormatKeys, fieldKeys).length === temporalFieldFormatKeys.length;
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
	getConstraints,
	supportsMultiDb,
	getDbVersion,
	setDependencies,
	setTimeOut,
	isTemporalTypeField,
	getTemporalFieldSchema,
};
