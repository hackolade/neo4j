const _ = require('lodash');
var neo4j = require('neo4j-driver').v1;
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

const getLabels = () => {
	return execute('MATCH (n) RETURN DISTINCT labels(n) as label').then((data) => {
			let labels = [];
			data.forEach((record) => {
				labels = labels.concat(record.label);
			});
			return labels
		});
};

const getRelationships = () => {
	return execute('MATCH (n)-[r]-() RETURN DISTINCT type(r) as relationship')
		.then((result) => {
			return result.map(record => record.relationship);
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

module.exports = {
	connect,
	close,
	getLabels,
	getRelationships,
	getSchema,
	getDatabaseName
};

// MATCH (a:Author)-[n]->() RETURN DISTINCT type(n) - relationships by label
// MATCH (labels)-[:LIKE]->() RETURN DISTINCT labels(labels) - labels by relationship
// MATCH (who)-[how]->(whom) RETURN DISTINCT labels(who) as who, type(how) as how, labels(whom) as whom
