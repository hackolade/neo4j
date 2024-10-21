const neo4j = require('neo4j-driver');
const fs = require('fs');
const _ = require('lodash');

let driver;
let isSshTunnel = false;

const EXECUTE_TIME_OUT_CODE = 'EXECUTE_TIME_OUT';
let timeout;

const setTimeOut = data => (timeout = data?.queryRequestTimeout || 300000);

const connectToInstance = (info, checkConnection) => {
	return checkConnection(info.host, info.port).then(
		() =>
			new Promise((resolve, reject) => {
				const uri = getConnectionURI(info);
				const username = info.username;
				const password = info.password;
				const sslOptions = getSSLConfig(info);
				const driverConfig = {
					...sslOptions,
					maxConnectionPoolSize: 500,
					connectionAcquisitionTimeout: 2 * 60 * 1000,
				};
				driver = neo4j.driver(uri, neo4j.auth.basic(username, password), driverConfig);

				driver
					.verifyConnectivity()
					.then(() => {
						resolve();
					})
					.catch(error => {
						driver = null;
						reject(error);
					});
			}),
	);
};

const connect = async (info, checkConnection, sshService) => {
	try {
		if (info.ssh) {
			const { options } = await sshService.openTunnel({
				sshAuthMethod: info.ssh_method === 'privateKey' ? 'IDENTITY_FILE' : 'USER_PASSWORD',
				sshTunnelHostname: info.ssh_host,
				sshTunnelPort: info.ssh_port,
				sshTunnelUsername: info.ssh_user,
				sshTunnelPassword: info.ssh_password,
				sshTunnelIdentityFile: info.ssh_key_file,
				sshTunnelPassphrase: info.ssh_key_passphrase,
				host: info.host,
				port: info.port,
			});

			isSshTunnel = true;
			info = {
				...info,
				...options,
			};
		}

		return connectToInstance(info, checkConnection);
	} catch (error) {
		error.step = 'Connection Error';
		throw error;
	}
};

const close = async sshService => {
	if (driver) {
		driver.close();
		driver = null;
	}

	if (isSshTunnel) {
		await sshService.closeConsumer();
		isSshTunnel = false;
	}
};

const execute = async (command, database = undefined, isMultiDb = false) => {
	if (!isMultiDb) {
		database = undefined;
	}
	const executeTimeout = new Promise((_, reject) =>
		setTimeout(() => reject(getExecuteTimeoutError(timeout)), timeout),
	);
	let result = [];
	let db;
	try {
		db = driver.session({ database });
		const executeWithOutTimeout = new Promise((resolve, reject) => {
			db.run(command).subscribe({
				onNext: record => {
					result.push(record.toObject());
				},
				onCompleted: () => {
					db.close();
					db = null;
					resolve(result);
				},
				onError: error => {
					db.close();
					db = null;
					reject(error);
				},
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

const getExecuteTimeoutError = timeout => {
	const error = new Error(`execute timeout: ${timeout}ms exceeded`);
	error.code = EXECUTE_TIME_OUT_CODE;
	return error;
};

const castInteger = properties => {
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

const getLabels = async ({ database, isMultiDb, logger }) => {
	try {
		const recordsCounter = await execute(
			'MATCH (n) RETURN DISTINCT COUNT(labels(n)) as labelsCount',
			database,
			isMultiDb,
		);
		logger.log('info', `Found ${_.head(recordsCounter).labelsCount} labels`, 'Retrieving labels information');

		const records = await execute('MATCH (n) RETURN DISTINCT labels(n) as label', database, isMultiDb);
		return _.flatMap(records, record => record.label);
	} catch (error) {
		const errorStep = error.step || 'Error of retrieving labels';
		logger.log('error', error, errorStep);
		return [];
	}
};

const getSchema = (dbName, labels, isMultiDb) => {
	return execute(`call apoc.meta.subGraph({labels: ["${labels.join('","')}]})`, dbName, isMultiDb)
		.then(
			result => result,
			error => {
				if (error?.code === EXECUTE_TIME_OUT_CODE) {
					throw error;
				}
				return execute('CALL db.schema.visualization()', dbName, isMultiDb);
			},
		)
		.then(result => {
			const nodes = result[0].nodes;
			const relationships = result[0].relationships;
			let data = [];

			relationships.forEach(relationship => {
				let res = {
					start: '',
					relationship: relationship.type,
					end: '',
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
			return await execute('call dbms.listConfig("active_database")').then(
				result => {
					return [_.get(result[0], 'value', defaultDbName)];
				},
				() => {
					return [defaultDbName];
				},
			);
		}
	} catch (error) {
		error.step = error.step || 'Error of retrieving database name';
	}
};

const supportsMultiDb = () => {
	return driver.supportsMultiDb();
};

const getActiveMultiDbsNames = async () => {
	const databases = await execute('SHOW DATABASES', 'system', true);
	return databases
		.filter(({ name, currentStatus }) => {
			return name !== 'system' && currentStatus === 'online';
		})
		.map(({ name }) => name);
};

const getNodes = (label, limit = 100, dbName, isMultiDb) => {
	return execute(`MATCH (row:\`${label}\`) RETURN row LIMIT ${limit}`, dbName, isMultiDb).then(result => {
		return result.map(record => castInteger(record.row.properties));
	});
};

const getRelationshipData = (start, relationship, end, limit = 100, dbName, isMultiDb) => {
	return execute(
		`MATCH (:\`${start}\`)-[row:\`${relationship}\`]-(:\`${end}\`) RETURN row LIMIT ${limit}`,
		dbName,
		isMultiDb,
	).then(result => {
		return result.map(record => castInteger(record.row.properties));
	});
};

const getNodesCount = (label, dbName, isMultiDb) => {
	return execute(`MATCH (a:\`${label}\`) RETURN count(a) AS count`, dbName, isMultiDb).then(
		result => castInteger(result[0]).count,
	);
};

const getCountRelationshipsData = (start, relationship, end, dbName, isMultiDb) => {
	return execute(
		`MATCH (:\`${start}\`)-[rel:\`${relationship}\`]-(:\`${end}\`) RETURN count(rel) AS count`,
		dbName,
		isMultiDb,
	).then(result => castInteger(result[0]).count);
};

const getIndexes = (dbName, isMultiDb, dbVersion) => {
	if (dbVersion === '5.x') {
		return execute('SHOW INDEXES', dbName, isMultiDb);
	}
	return execute('CALL db.indexes()', dbName, isMultiDb);
};

const getConstraints = (dbName, isMultiDb, dbVersion) => {
	if (dbVersion === '5.x') {
		return execute('SHOW CONSTRAINTS', dbName, isMultiDb);
	}
	return execute('CALL db.constraints()', dbName, isMultiDb);
};

const getSSLConfig = info => {
	if (
		info.host?.startsWith('neo4j+s://') &&
		!['TRUST_CUSTOM_CA_SIGNED_CERTIFICATES', 'TRUST_SERVER_CLIENT_CERTIFICATES'].includes(info.sslType)
	) {
		return {};
	}

	let config = {
		encrypted: 'ENCRYPTION_ON',
		trust: info.sslType,
	};

	switch (info.sslType) {
		case 'TRUST_ALL_CERTIFICATES':
		case 'TRUST_SYSTEM_CA_SIGNED_CERTIFICATES':
			return config;
		case 'TRUST_CUSTOM_CA_SIGNED_CERTIFICATES':
			config.trustedCertificates = [info.certAuthority];
			return config;
		case 'TRUST_SERVER_CLIENT_CERTIFICATES':
			config.trustedCertificates = [info.certAuthority];
			config.key = info.clientPrivateKey;
			config.cert = info.clientCert;
			config.passphrase = info.passphrase;
			return config;
		case 'Off':
		default:
			return {};
	}
};

const getRawDbVersion = async () => {
	const versionResponse = await execute(
		'call dbms.components() yield versions unwind versions as version return version',
	);
	return _.head(versionResponse)?.version;
};

const getDbVersion = async () => {
	try {
		const version = await getRawDbVersion();
		const [major, minor] = version.split('.');
		const v4 = major === '4';
		const v5 = major === '5';

		if (v4 && minor === '3') {
			return '4.3';
		} else if (v4 && minor >= '4') {
			return '4.4';
		} else if (v4) {
			return '4.0-4.2';
		} else if (v5) {
			return '5.x';
		}
		return '3.x';
	} catch (err) {
		return '3.x';
	}
};

const checkConnection = () => {
	return driver._connectionProvider.acquireConnection().then(conn => {
		return driver._validateConnection(conn);
	});
};

const isTemporalTypeField = field => {
	return (
		isDate(field) ||
		isDateTime(field) ||
		isDuration(field) ||
		isLocalDateTime(field) ||
		isLocalTime(field) ||
		isTime(field)
	);
};

const getTemporalFieldSchema = field => {
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
};

const isDate = filed => {
	const keys = ['year', 'month', 'day', 'toString'];
	return isTemporalField(keys, filed);
};
const isDateTime = filed => {
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
};
const isDuration = filed => {
	const keys = ['months', 'days', 'seconds', 'nanoseconds', 'toString'];
	return isTemporalField(keys, filed);
};
const isLocalDateTime = filed => {
	const keys = ['year', 'month', 'day', 'hour', 'minute', 'second', 'nanosecond', 'toString'];
	return isTemporalField(keys, filed);
};
const isLocalTime = filed => {
	const keys = ['hour', 'minute', 'second', 'nanosecond', 'toString'];
	return isTemporalField(keys, filed);
};
const isTime = filed => {
	const keys = ['hour', 'minute', 'second', 'nanosecond', 'timeZoneOffsetSeconds', 'toString'];
	return isTemporalField(keys, filed);
};

const isTemporalField = (temporalFieldFormatKeys, field) => {
	const fieldKeys = Object.keys(field);
	return (
		fieldKeys.length === temporalFieldFormatKeys.length &&
		_.intersection(temporalFieldFormatKeys, fieldKeys).length === temporalFieldFormatKeys.length
	);
};

const getConnectionURI = info => {
	let host = '';
	const neo4jProtocolRegex = /^neo4j(\+s|s|)(\+ssc|ssc|):\/\//i;
	if (neo4jProtocolRegex.test(info.host)) {
		host = info.host;
	} else {
		host = `bolt://${info.host}`;
	}
	if (info.port) {
		host = `${host}:${info.port}`;
	}

	return host;
};

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
	setTimeOut,
	isTemporalTypeField,
	getTemporalFieldSchema,
	execute,
	getRawDbVersion,
};
