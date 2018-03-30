'use strict';

const config = require("./config");
const documentClient = require("documentdb").DocumentClient;
const client = new documentClient(config.endpoint, { "masterKey": config.accountKey });
const async = require('async');
const _ = require('lodash');

module.exports = {
	connect: function(connectionInfo, cb){
		cb()
	},

	disconnect: function(connectionInfo, cb){
		cb()
	},

	testConnection: function(connectionInfo, cb){
		cb(true);
	},

	getDatabases: function(connectionInfo, cb){
		listDatabases((err, dbs) => {
			if(err){
				console.log(err);
			} else {
				dbs = dbs.map(item => item.id);
				cb(err, dbs);
			}
		});
	},

	getDocumentKinds: function(connectionInfo, cb) {
		readDatabaseById(connectionInfo.database, (err, database) => {
			if(err){
				console.log(err);
			} else {
				listCollections(database._self, (err, collections) => {
					if(err){
						console.log(err);
						dbItemCallback(err)
					} else {

						async.map(collections, (collectionItem, collItemCallback) => {
							readCollectionById(database.id, collectionItem.id, (err, collection) => {
								if(err){
									console.log(err);
								} else {
									let size = getSampleDocSize(1000, connectionInfo.recordSamplingSettings) || 1000;

									listDocuments(collection._self, size, (err, documents) => {
										if(err){
											console.log(err);
										} else {
											documents  = filterDocuments(documents);

											let inferSchema = generateCustomInferSchema(collectionItem.id, documents, { sampleSize: 20 });
											let documentsPackage = getDocumentKindDataFromInfer({ bucketName: collectionItem.id, inference: inferSchema, isCustomInfer: true }, 90);

											collItemCallback(err, documentsPackage);
										}
									});
								}
							});
						}, (err, items) => {
							if(err){
								console.log(err);
							}
							return cb(err, items);
						});
					}
				});
			}
		});
	},

	getDbCollectionsNames: function(connectionInfo, cb) {
		readDatabaseById(connectionInfo.database, (err, database) => {
			if(err){
				console.log(err);
			} else {
				listCollections(database._self, (err, collections) => {
					if(err){
						console.log(err);
						cb(err)
					} else {
						let collectionNames = collections.map(item => item.id);
						handleBucket(connectionInfo, collectionNames, database, cb);
					}
				});
			}
		});
	},

	getDbCollectionsData: function(data, cb){
		let includeEmptyCollection = data.includeEmptyCollection;
		let { recordSamplingSettings, fieldInference } = data;
		let size = getSampleDocSize(1000, recordSamplingSettings) || 1000;
		let bucketList = data.collectionData.dataBaseNames;

		readDatabaseById(data.database, (err, database) => {
			if(err){
				console.log(err);
			} else {
				async.map(bucketList, (bucketName, collItemCallback) => {
					readCollectionById(database.id, bucketName, (err, collection) => {
						if(err){
							console.log(err);
						} else {
							getOfferType(collection, (err, info) => {
								if(err){

								} else {
									let bucketInfo = {
										throughput: info.content.offerThroughput,
										rump: info.content.offerIsRUPerMinuteThroughputEnabled ? 'OFF' : 'On'
 									};

 									let indexes = getIndexes(collection.indexingPolicy);

									listDocuments(collection._self, size, (err, documents) => {
										if(err){
											console.log(err);
										} else {
											documents = filterDocuments(documents);
											let documentKindName = data.documentKinds[collection.id].documentKindName || '*';
											let docKindsList = data.collectionData.collections[bucketName];
											let collectionPackages = [];

											if(documentKindName !== '*'){
												docKindsList.forEach(docKindItem => {
													let newArrayDocuments = documents.filter((item) => {
														return item[documentKindName] === docKindItem;
													});

													let documentsPackage = {
														dbName: bucketName,
														collectionName: docKindItem,
														documents: newArrayDocuments || [],
														indexes: [],
														bucketIndexes: indexes,
														views: [],
														validation: false,
														docType: documentKindName,
														bucketInfo
													};

													if(fieldInference.active === 'field'){
														documentsPackage.documentTemplate = documents[0] || null;
													}

													collectionPackages.push(documentsPackage)
												});
											}

											collItemCallback(err, collectionPackages);
										}
									});
								}
							})
						}
					});
				}, (err, items) => {
					if(err){
						console.log(err);
					}
					return cb(err, items);
				});
			}
		});
	}
};


function readCollectionById(dbLink, collectionId, callback) {
	var collLink = `dbs/${dbLink}/colls/${collectionId}`;

	client.readCollection(collLink, function (err, coll) {
		if (err) {
			console.log(err);
			callback(err);
		} else {
			callback(null, coll);
		}
	});
}

function getOfferType(collection, callback) {
	var querySpec = {
		query: 'SELECT * FROM root r WHERE  r.resource = @link',
		parameters: [
			{
				name: '@link',
				value: collection._self
			}
		]
	};

	client.queryOffers(querySpec).toArray(function (err, offers) {
		if (err) {
			callback(err);

		} else if (offers.length === 0) {
			callback('No offer found for collection');

		} else {
			var offer = offers[0];
			callback(null, offer);
		}
	});
}

function listDatabases(callback) {
	var queryIterator = client.readDatabases().toArray(function (err, dbs) {
		if (err) {
			callback(err);
		}

		callback(null, dbs);
	});
}

function listCollections(databaseLink, callback) {
	var queryIterator = client.readCollections(databaseLink).toArray(function (err, cols) {
		if (err) {
			callback(err);
		} else {            
			callback(null, cols);
		}
	});
}

function readDatabaseById(databaseId, callback) {
	client.readDatabase('dbs/' + databaseId, function (err, db) {
		if (err) {
			callback(err);
		} else {
			callback(null, db);
		}
	});
}

function listDocuments(collLink, maxItemCount, callback) {
	var queryIterator = client.readDocuments(collLink, { maxItemCount }).toArray(function (err, docs) {
		if (err) {
			callback(err);
		} else {
			callback(null, docs);
		}
	});
}

function filterDocuments(documents){
	return documents.map(item =>{
		for(let prop in item){
			if(prop && prop[0] === '_'){
				delete item[prop];
			}
		}
		return item;
	});
}

function generateCustomInferSchema(bucketName, documents, params){
	function typeOf(obj) {
		return {}.toString.call(obj).split(' ')[1].slice(0, -1).toLowerCase();
	};

	let sampleSize = params.sampleSize || 30;

	let inferSchema = {
		"#docs": 0,
		"$schema": "http://json-schema.org/schema#",
		"properties": {}
	};

	documents.forEach(item => {
		inferSchema["#docs"]++;
		
		for(let prop in item){
			if(inferSchema.properties.hasOwnProperty(prop)){
				inferSchema.properties[prop]["#docs"]++;
				inferSchema.properties[prop]["samples"].indexOf(item[prop]) === -1 && inferSchema.properties[prop]["samples"].length < sampleSize? inferSchema.properties[prop]["samples"].push(item[prop]) : '';
				inferSchema.properties[prop]["type"] = typeOf(item[prop]);
			} else {
				inferSchema.properties[prop] = {
					"#docs": 1,
					"%docs": 100,
					"samples": [item[prop]],
					"type": typeOf(item[prop])
				}
			}
		}
	});

	for (let prop in inferSchema.properties){
		inferSchema.properties[prop]["%docs"] = Math.round((inferSchema.properties[prop]["#docs"] / inferSchema["#docs"] * 100), 2);
	}
	return inferSchema;
}

function getDocumentKindDataFromInfer(data, probability){
	let suggestedDocKinds = [];
	let otherDocKinds = [];
	let documentKind = {
		key: '',
		probability: 0	
	};

	if(data.isCustomInfer){
		let minCount = Infinity;
		let inference = data.inference.properties;

		for(let key in inference){
			if(config.excludeDocKind.indexOf(key) === -1){
				if(inference[key]["%docs"] >= probability && inference[key].samples.length && typeof inference[key].samples[0] !== 'object'){
					suggestedDocKinds.push(key);

					if(inference[key]["%docs"] >= documentKind.probability && inference[key].samples.length < minCount){
						minCount = inference[key].samples.length;
						documentKind.probability = inference[key]["%docs"];
						documentKind.key = key;
					}
				} else {
					otherDocKinds.push(key);
				}
			}
		}
	} else {
		let flavor = (data.flavorValue) ? data.flavorValue.split(',') : data.inference[0].Flavor.split(',');
		if(flavor.length === 1){
			suggestedDocKinds = Object.keys(data.inference[0].properties);
			let matсhedDocKind = flavor[0].match(/([\s\S]*?) \= "?([\s\S]*?)"?$/);
			documentKind.key = (matсhedDocKind.length) ? matсhedDocKind[1] : '';
		}
	}

	let documentKindData = {
		bucketName: data.bucketName,
		documentList: suggestedDocKinds,
		documentKind: documentKind.key,
		preSelectedDocumentKind: data.preSelectedDocumentKind,
		otherDocKinds
	};

	return documentKindData;
}

function handleBucket(connectionInfo, collectionNames, database, dbItemCallback){
	let size = getSampleDocSize(1000, connectionInfo.recordSamplingSettings) || 1000;

	async.map(collectionNames, (collectionName, collItemCallback) => {
		readCollectionById(database.id, collectionName, (err, collection) => {
			if(err){
				console.log(err);
			} else {
				listDocuments(collection._self, size, (err, documents) => {
					if(err){
						console.log(err);
					} else {
						documents  = filterDocuments(documents);
						let documentKind = connectionInfo.documentKinds[collection.id].documentKindName || '*';
						let documentTypes = [];

						if(documentKind !== '*'){
							documentTypes = documents.map(function(doc){
								return doc[documentKind];
							});
							documentTypes = documentTypes.filter((item) => Boolean(item));
							documentTypes = _.uniq(documentTypes);
						}

						let dataItem = prepareConnectionDataItem(documentTypes, collection.id, database);
						collItemCallback(err, dataItem);
					}
				});
			}
		});
	}, (err, items) => {
		if(err){
			console.log(err);
		}
		return dbItemCallback(err, items);
	});
}

function prepareConnectionDataItem(documentTypes, bucketName, database){
	let uniqueDocuments = _.uniq(documentTypes);
	let connectionDataItem = {
		dbName: bucketName,
		dbCollections: uniqueDocuments
	};

	return connectionDataItem;
}

function getSampleDocSize(count, recordSamplingSettings) {
	let per = recordSamplingSettings.relative.value;
	return (recordSamplingSettings.active === 'absolute')
		? recordSamplingSettings.absolute.value
			: Math.round( count/100 * per);
}

function getIndexes(indexingPolicy){
	let generalIndexes = [];
	
	if(indexingPolicy){
		indexingPolicy.includedPaths.forEach(item => {
			let indexes = item.indexes;
			indexes = indexes.map(index => {
				index.indexPrecision = index.precision;
				index.automatic = item.automatic;
				index.mode = indexingPolicy.indexingMode;
				index.indexIncludedPath = item.path;
				return index;
			});

			generalIndexes = generalIndexes.concat(generalIndexes, indexes);
		});
	}

	return generalIndexes;
}