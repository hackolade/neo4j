'use strict';

const async = require('async');
const _ = require('lodash');
const neo4j = require('./neo4jHelper');

module.exports = {
	connect: function(connectionInfo, logger, cb){
		neo4j.connect(connectionInfo).then(cb, cb);
	},

	disconnect: function(connectionInfo, cb){
		neo4j.close();
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
		logger.log('info', connectionInfo, 'connectionInfo', connectionInfo.hiddenKeys);
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

			getNodesData(dbName, labels, {
				recordSamplingSettings,
				fieldInference,
				includeEmptyCollection
			}).then((labelPackages) => {
				packages.labels.push(labelPackages);
				labels = labelPackages.reduce((result, packageData) => result.concat([packageData.collectionName]), []);
				return neo4j.getSchema();
			}).then((schema) => {
				return schema.filter(data => {
					return (labels.indexOf(data.start) !== -1 && labels.indexOf(data.end) !== -1);
				});
			}).then((schema) => {
				return getRelationshipData(schema, dbName, recordSamplingSettings);
			}).then((relationships) => {
				packages.relationships.push(relationships);
				next(null);
			}).catch(error => {
				next(error);
			});
		}, (err) => {
			cb(err, packages.labels, {}, packages.relationships);
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
				const packageData = getLabelPackage(dbName, labelName, documents, data.includeEmptyCollection, data.fieldInference);
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

const getRelationshipData = (schema, dbName, recordSamplingSettings) => {
	return new Promise((resolve, reject) => {
		async.map(schema, (chain, nextChain) => {
			neo4j.getCountRelationshipsData(chain.start, chain.relationship, chain.end).then((quantity) => {
				const count = getCount(quantity, recordSamplingSettings);
				return neo4j.getRelationshipData(chain.start, chain.relationship, chain.end, count);
			}).then((documents) => {
				nextChain(null, {
					dbName,
					start: chain.start, 
					relationship: chain.relationship, 
					end: chain.end,
					documents
				});
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

const getLabelPackage = (dbName, labelName, documents, includeEmptyCollection, fieldInference) => {
	let packageData = {
		dbName: dbName,
		collectionName: labelName,
		documents,
		indexes: [],
		bucketIndexes: [],
		views: [],
		validation: false,
		emptyBucket: false,
		bucketInfo: {}
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

