'use strict';

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
			
			cb(null, result);
		}).catch((error) => {
			cb(error || 'error');
		});
	},

	getDbCollectionsData: function(data, logger, cb){
		neo4j.getSchema().then(schema => {
			cb(null, schema);
		}).catch(error => {
			cb(error);
		});
	}
};
