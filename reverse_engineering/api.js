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
		const packages = packageCreator(data);

		async.map(dataBaseNames, (dbName, next) => {
			const labels = collections[dbName];
			packages.setDbName(dbName);
			neo4j.getSchema().then((schema) => {
				let relationships = {};
				schema.forEach(data => {
					if (labels.indexOf(data.start)) {
						if (!relationships[data.start]) {
							relationships[data.start] = [];
						}
						relationships[data.start].push(data.relationship);
					}
				})
				return relationships;
			}).then(relationships => {
				async.map(labels, (labelName, nextlabel) => {
					neo4j.getNodesCount(labelName).then(quantity => {
						const count = getCount(quantity, recordSamplingSettings);
						return neo4j.getNodes(labelName, count);
					}).then((documents) => {
						packages.setLabelName(labelName);
						packages.add(documents);
						return getRelationshipData(labelName, _.uniq(relationships[labelName] || []), recordSamplingSettings, packages);
					}).then(() => {
						nextlabel(null);
					});
				}, (err) => {
					if (err) {
						next(err);
					} else {
						next(null);
					}
				});
			}).catch(error => {
				next(error);
			});
		}, (err) => {
			cb(err, packages.get(), {});
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

const getRelationshipData = (labelName, relationships, recordSamplingSettings, packages) => {
	return new Promise((resolve, reject) => {
		async.map(relationships, (relationship, nextRelationship) => {
			neo4j.getCountRelationshipsData(labelName, relationship).then((quantity) => {
				const count = getCount(quantity, recordSamplingSettings);
				return neo4j.getRelationshipData(labelName, relationship, count);
			}).then((data) => {
				packages.setLabelName(relationship);
				packages.add(data);
				nextRelationship(null);
			}).catch(nextRelationship);
		}, (err) => {
			if (err) {
				reject(err);
			} else {
				resolve();
			}
		});
	});
};

const packageCreator = (params) => {
	const includeEmptyCollection = params.includeEmptyCollection;
	const fieldInference = params.fieldInference;
	let dbName;
	let labelName;
	let packages = [];

	return {
		add(documents) {
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
				packageData.documentTemplate = this.getTemplate(documents);
			}

			if (includeEmptyCollection || !isEmptyLabel(documents)) {
				packages.push(packageData);
			}
		},

		getTemplate(documents) {
			return documents.reduce((tpl, doc) => _.merge(tpl, doc), {});
		},

		get() {
			return packages;
		},

		setDbName(name) {
			dbName = name;
		},

		setLabelName(name) {
			labelName = name;
		}
	};
}
