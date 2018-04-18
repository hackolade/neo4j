const _ = require('lodash');
const neo4j = require('neo4j-driver').v1;
let driver;

const connect = (info) => {
	return new Promise((resolve, reject) => {
		const host = info.host;
		const port = info.port;
		const username = info.username;
		const password = info.password;

		driver = neo4j.driver(`bolt://${host}:${port}`, neo4j.auth.basic(username, password));

		driver.onCompleted = () => {
			resolve();
		};

		driver.onError = (error) => {
			driver = null;
			reject(error);
		};
	});
};

const close = () => {
	if (driver) {
		driver.close();
		driver = null;
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
	return execute(`MATCH (row:${label}) RETURN row LIMIT ${limit}`)
		.then((result) => {
			return result.map(record => castInteger(record.row.properties));
		});
};

const getRelationshipData = (start, relationship, end, limit = 100) => {
	return execute(`MATCH (:${start})-[row:${relationship}]-(:${end}) RETURN row LIMIT ${limit}`)
		.then((result) => {
			return result.map(record => castInteger(record.row.properties));
		});
};

const getNodesCount = (label) => {
	return execute(`MATCH (a:${label}) RETURN count(a) AS count`).then(result => castInteger(result[0]).count);
};

const getCountRelationshipsData = (start, relationship, end) => {
	return execute(`MATCH (:${start})-[rel:${relationship}]-(:${end}) RETURN count(rel) AS count`).then(result => castInteger(result[0]).count);
};

const getIndexes = () => {
	return execute('CALL db.indexes()');
};

const getConstraints = () => {
	return execute('CALL db.constraints()');
};

module.exports = {
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
