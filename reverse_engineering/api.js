'use strict';

const async = require('async');
const _ = require('lodash');
const neo4j = require('./neo4jHelper');

module.exports = {
	connect: function(connectionInfo, logger, cb){
		logger.clear();
		logger.log('info', connectionInfo, 'connectionInfo', connectionInfo.hiddenKeys);
		neo4j.connect(connectionInfo).then(cb, cb);
	},

	disconnect: function(connectionInfo, cb){
		neo4j.close();
		cb();
	},

	testConnection: function(connectionInfo, logger, cb){
		this.connect(connectionInfo, logger, (error) => {
			this.disconnect();
			cb(error);
		});
	},

	getDatabases: function(connectionInfo, logger, cb){
		cb();
	},

	getDocumentKinds: function(connectionInfo, logger, cb) {
		cb();
	},

	getDbCollectionsNames: function(connectionInfo, logger, cb) {
		let result = {
			dbName: '',
			dbCollections: ''
		};
		neo4j.connect(connectionInfo).then(() => {
			return neo4j.getLabels();
		}).then((labels) => {
			result.dbCollections = labels;
		}).then(() => {
			return neo4j.getDatabaseName();
		}).then(dbName => {
			result.dbName = dbName;
			
			cb(null, [result]);
		}).catch((error) => {
			cb(error || 'error');
		});
	},

	getDbCollectionsData: function(data, logger, cb){
		const collections = data.collectionData.collections;
		const dataBaseNames = data.collectionData.dataBaseNames;
		const fieldInference = data.fieldInference;
		const includeEmptyCollection = data.includeEmptyCollection;
		const includeSystemCollection = data.includeSystemCollection;
		const recordSamplingSettings = data.recordSamplingSettings;
		let packages = {
			labels: [],
			relationships: []
		};

		async.map(dataBaseNames, (dbName, next) => {
			let labels = collections[dbName];
			let metaData = {};

			neo4j.getIndexes().then((indexes) => {
				metaData.indexes = prepareIndexes(indexes);

				return neo4j.getConstraints();
			}).then((constraints) => {
				metaData.constraints = prepareConstraints(constraints);

				return metaData;
			}).then(metaData => {
				return getNodesData(dbName, labels, {
					recordSamplingSettings,
					fieldInference,
					includeEmptyCollection,
					indexes: metaData.indexes,
					constraints: metaData.constraints
				});
			}).then((labelPackages) => {
				packages.labels.push(labelPackages);
				labels = labelPackages.reduce((result, packageData) => result.concat([packageData.collectionName]), []);
				return neo4j.getSchema();
			}).then((schema) => {
				return schema.filter(data => {
					return (labels.indexOf(data.start) !== -1 && labels.indexOf(data.end) !== -1);
				});
			}).then((schema) => {
				return getRelationshipData(schema, dbName, recordSamplingSettings, fieldInference);
			}).then((relationships) => {
				packages.relationships.push(relationships);
				next(null);
			}).catch(error => {
				logger.log('error', prepareError(error), "Error");
				next(prepareError(error));
			});
		}, (err) => {
			cb(err, packages.labels, {}, [].concat.apply([], packages.relationships));
		});
	}
};

const getCount = (count, recordSamplingSettings) => {
	const per = recordSamplingSettings.relative.value;
	const size = (recordSamplingSettings.active === 'absolute')
		? recordSamplingSettings.absolute.value
		: Math.round(count / 100 * per);
	return size;
};

const isEmptyLabel = (documents) => {
	if (!Array.isArray(documents)) {
		return true;
	}

	return documents.reduce((result, doc) => result && _.isEmpty(doc), true);
};

const getTemplate = (documents) => {
	return documents.reduce((tpl, doc) => _.merge(tpl, doc), {});
};

const getNodesData = (dbName, labels, data) => {
	return new Promise((resolve, reject) => {
		let packages = [];
		async.map(labels, (labelName, nextLabel) => {
			neo4j.getNodesCount(labelName).then(quantity => {
				const count = getCount(quantity, data.recordSamplingSettings);

				return neo4j.getNodes(labelName, count);
			}).then((documents) => {
				const packageData = getLabelPackage(
					dbName, 
					labelName, 
					documents, 
					data.includeEmptyCollection, 
					data.fieldInference,
					data.indexes[labelName],
					data.constraints[labelName] 
				);
				if (packageData) {
					packages.push(packageData);
				}
				nextLabel(null);
			}).catch(nextLabel);
		}, (err) => {
			if (err) {
				reject(err);
			} else {
				resolve(packages);
			}
		});
	});
};

const getRelationshipData = (schema, dbName, recordSamplingSettings, fieldInference) => {
	return new Promise((resolve, reject) => {
		async.map(schema, (chain, nextChain) => {
			neo4j.getCountRelationshipsData(chain.start, chain.relationship, chain.end).then((quantity) => {
				const count = getCount(quantity, recordSamplingSettings);
				return neo4j.getRelationshipData(chain.start, chain.relationship, chain.end, count);
			}).then((documents) => {
				let packageData = {
					dbName,
					parentCollection: chain.start, 
					relationshipName: chain.relationship, 
					childCollection: chain.end,
					documents
				};

				if (fieldInference.active === 'field') {
					packageData.documentTemplate = getTemplate(documents);
				}

				nextChain(null, packageData);
			}).catch(nextChain);
		}, (err, packages) => {
			if (err) {
				reject(err);
			} else {
				resolve(packages);
			}
		});
	});
};

const getLabelPackage = (dbName, labelName, documents, includeEmptyCollection, fieldInference, indexes, constraints) => {
	let packageData = {
		dbName: dbName,
		collectionName: labelName,
		documents,
		indexes: [],
		bucketIndexes: [],
		views: [],
		validation: false,
		emptyBucket: false,
		bucketInfo: {},
		entityLevel: {
			constraint: constraints,
			index: indexes
		}
	};

	if (fieldInference.active === 'field') {
		packageData.documentTemplate = getTemplate(documents);
	}

	if (includeEmptyCollection || !isEmptyLabel(documents)) {
		return packageData;
	} else {
		return null;
	}
}; 

const prepareIndexes = (indexes) => {
	const hasProperties = /INDEX\s+ON\s+\:(.*)\((.*)\)/i;
	let map = {};

	indexes.forEach((index, i) => {
		if (index.properties) {
			index.properties = index.properties;
		} else if (hasProperties.test(index.description)) {
			let parsedDescription = index.description.match(hasProperties);
			index.label = parsedDescription[1];
			index.properties = parsedDescription[2].split(',').map(s => s.trim());
		} else {
			index.properties = [];
		}

		if (!map[index.label]) {
			map[index.label] = [];
		}

		map[index.label].push({
			name: `Index :${index.label}.[${index.properties.join(',')}]`,
			key: index.properties,
			state: index.state,
			type: index.type,
			provider: JSON.stringify(index.provider, null , 4),
			description: index.description
		});
	});

	return map;
};

const prepareConstraints = (constraints) => {
	const isUnique = /^constraint\s+on\s+\(\s*.+\:([a-z0-9-_*\.]+)\s+\)\s+assert\s+.+\.([a-z0-9-_*\.]+)\s+IS\s+UNIQUE/i; // 1,2
	const isNodeKey = /^constraint\s+on\s+\(\s*.+\:([a-z0-9-_*\.]+)\s+\)\s+assert\s+\(\s*(.+)\s*\)\s+IS\s+NODE\s+KEY/i; // 1, 2
	const isExists = /^constraint\s+on\s+\(\s*.+\:([a-z0-9-_*\.]+)\s+\)\s+assert\s+exists\(\s*.+\.(.+)\s*\)/i; // 1, 2
	let result = {};
	const addToResult = (result, name, label, key, description) => {
		if (!result[label]) {
			result[label] = [];
		}

		result[label].push({ name, key, description });
	};

	constraints.forEach(c => {
		const constraint = c.description.trim();

		if (isUnique.test(constraint)) {
			let data = constraint.match(isUnique);
			let label = data[1];
			let field = data[2];

			addToResult(result, `Unique ${label}.${field}`, label, [field], constraint);
		} else if (isExists.test(constraint)) {
			let data = constraint.match(isExists);
			let label = data[1];
			let field = data[2];

			addToResult(result, `Required ${label}.${field}`, label, [field], constraint);
		} else if (isNodeKey.test(constraint)) {
			let data = constraint.match(isNodeKey);
			let label = data[1];
			let fields = data[2];

			if (fields) {
				fields = fields.split(",").map(s => {
					const field = s.trim().match(/.+\.(.+)/);
					
					if (field) {
						return field[1].trim();
					} else {
						return s;
					}
				});
				addToResult(result, `Node key :${label}`, label, fields, constraint);				
			}
		}
	});

	return result;
};

const prepareError = (error) => {
	return {
		message: error.message,
		stack: error.stack
	};
};
