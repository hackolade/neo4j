'use strict';

const { dependencies, setDependencies } = require('./appDependencies');
const neo4j = require('./neo4jHelper');
const snippetsPath = '../snippets/';
const logHelper = require('./logHelper');
let _;
let async;

const snippets = {
	'Cartesian 3D': require(snippetsPath + 'cartesian-3d.json'),
	'Cartesian': require(snippetsPath + 'cartesian.json'),
	'WGS-84-3D': require(snippetsPath + 'point-wgs-84-3d.json'),
	'WGS-84': require(snippetsPath + 'point-wgs-84.json'),
};

module.exports = {
	connect: function (connectionInfo, logger, cb, app) {
		const sshService = app.require('@hackolade/ssh-service');

		initDependencies(app);

		neo4j.connect(connectionInfo, checkConnection(logger), sshService).then(
			() => {
				logger.log('info', 'Successfully connected to the database instance', 'Connection');

				cb();
			},
			error => {
				logger.log('error', prepareError(error), 'Connection error');

				setTimeout(() => {
					cb({ ...prepareError(error), type: 'simpleError' });
				}, 1000);
			},
		);
	},

	disconnect: function (connectionInfo, cb, app) {
		const sshService = app.require('@hackolade/ssh-service');
		neo4j.close(sshService);
		cb();
	},

	testConnection: function (connectionInfo, logger, cb, app) {
		logInfo('Test connection', connectionInfo, logger);

		initDependencies(app);
		this.connect(
			connectionInfo,
			logger,
			error => {
				this.disconnect(connectionInfo, () => {}, app);
				cb(error);
			},
			app,
		);
	},

	getDatabases: function (connectionInfo, logger, cb) {
		cb();
	},

	getDocumentKinds: function (connectionInfo, logger, cb) {
		cb();
	},

	getDbCollectionsNames: async function (connectionInfo, logger, cb, app) {
		logInfo('Retrieving labels information', connectionInfo, logger);
		try {
			const sshService = app.require('@hackolade/ssh-service');
			initDependencies(app);
			neo4j.setTimeOut(connectionInfo);

			await neo4j.connect(connectionInfo, checkConnection(logger), sshService);
			logger.log('info', 'Successfully connected to the database instance', 'Connection');

			const isMultiDb = await neo4j.supportsMultiDb();

			const databaseNames = await neo4j.getDatabaseName('graph.db', isMultiDb);
			logger.log('info', 'Name of database successfully retrieved', 'Retrieving labels information');
			const result = await Promise.all(
				databaseNames.map(async name => {
					return {
						dbName: name,
						dbCollections: await neo4j.getLabels(name, isMultiDb),
					};
				}),
			);
			logger.log('info', 'Labels successfully retrieved', 'Retrieving labels information');
			logger.log('info', 'Information about labels successfully retrieved', 'Retrieving labels information');
			cb(null, result);
		} catch (error) {
			logger.log(
				'error',
				{
					message: error.step || 'Process of retrieving labels was interrupted by error',
					error: prepareError(error),
				},
				'Retrieving labels information',
			);

			const mappedError = {
				...prepareError(error),
				type: !error.type && error.step === 'Connection Error' ? 'simpleError' : null,
				message: error.message || 'Process of retrieving labels was interrupted by error',
			};

			setTimeout(() => {
				cb(mappedError || 'error');
			}, 1000);
		}
	},

	getDbCollectionsData: async function (data, logger, cb, app) {
		try {
			await this.getDbCollectionsDataWrapped(data, logger, cb, app);
		} catch (error) {
			logger.log('error', prepareError(error), 'RE Get Collections Data');
			cb(error);
		}
	},

	getDbCollectionsDataWrapped: async function (data, logger, cb, app) {
		initDependencies(app);
		neo4j.setTimeOut(data);
		logger.log('info', data, 'Retrieving schema for chosen labels', data.hiddenKeys);

		const collections = data.collectionData.collections;
		const dataBaseNames = data.collectionData.dataBaseNames;
		const fieldInference = data.fieldInference;
		const includeEmptyCollection = data.includeEmptyCollection;
		const recordSamplingSettings = data.recordSamplingSettings;
		let packages = {
			labels: [],
			relationships: [],
		};
		logger.progress = logger.progress || (() => {});

		logger.progress({ message: 'Start Reverse Engineering Neo4j', containerName: '', entityName: '' });
		logger.log('info', '', 'Start Reverse Engineering Neo4j');

		const isMultiDb = await neo4j.supportsMultiDb();
		const modelProps = {
			dbVersion: await neo4j.getDbVersion(),
		};

		async.map(
			dataBaseNames,
			(dbName, next) => {
				let labels = collections[dbName];
				let metaData = {};

				logger.progress({ message: 'Start retrieving indexes', containerName: dbName, entityName: '' });
				logger.log('info', dbName, 'Start retrieving indexes');

				neo4j
					.getIndexes(dbName, isMultiDb, modelProps.dbVersion)
					.then(indexes => {
						metaData.indexes =
							modelProps.dbVersion === '3.x' ? prepareIndexes3x(indexes) : prepareIndexes4x(indexes);

						const countIndexes = (indexes && indexes.length) || 0;
						logger.progress({
							message: 'Indexes retrieved successfully. Found ' + countIndexes + ' index(es)',
							containerName: dbName,
							entityName: '',
						});
						logger.progress({
							message: 'Start retrieving constraints',
							containerName: dbName,
							entityName: '',
						});
						logger.log('info', dbName, 'Start retrieving constraints');

						return neo4j.getConstraints(dbName, isMultiDb, modelProps.dbVersion);
					})
					.then(constraints => {
						metaData.constraints = prepareConstraints(constraints, modelProps.dbVersion);

						const countConstraints = (constraints && constraints.length) || 0;
						logger.progress({
							message: 'Constraints retrieved successfully ' + countConstraints + ' constraint(s)',
							containerName: dbName,
							entityName: '',
						});
						logger.log('info', `${countConstraints} constraint(s)`, 'Constraints retrieved successfully ');

						return metaData;
					})
					.then(metaData => {
						return getNodesData(
							dbName,
							labels,
							isMultiDb,
							{
								recordSamplingSettings,
								fieldInference,
								includeEmptyCollection,
								indexes: metaData.indexes,
								constraints: metaData.constraints,
							},
							(entityName, message) => logger.progress({ message, containerName: dbName, entityName }),
						);
					})
					.then(labelPackages => {
						packages.labels.push(labelPackages);
						labels = labelPackages.reduce(
							(result, packageData) => result.concat([packageData.collectionName]),
							[],
						);

						logger.progress({
							message: 'Start retrieving schema...',
							containerName: dbName,
							entityName: '',
						});
						logger.log('info', dbName, 'Start retrieving schema');

						return neo4j.getSchema(dbName, labels, isMultiDb);
					})
					.then(schema => {
						logger.progress({
							message: 'Schema retrieved successfully',
							containerName: dbName,
							entityName: '',
						});
						logger.log('info', dbName, 'Schema retrieved successfully');

						return schema.filter(data => {
							return labels.indexOf(data.start) !== -1 && labels.indexOf(data.end) !== -1;
						});
					})
					.then(schema => {
						logger.progress({
							message: 'Start retrieving relationships...',
							containerName: dbName,
							entityName: '',
						});
						logger.log('info', dbName, 'Start retrieving relationships');

						return getRelationshipData(
							schema,
							dbName,
							modelProps.dbVersion,
							recordSamplingSettings,
							fieldInference,
							metaData,
							isMultiDb,
						);
					})
					.then(relationships => {
						logger.progress({
							message: 'Relationships retrieved successfully',
							containerName: dbName,
							entityName: '',
						});
						logger.log('info', dbName, 'Relationships retrieved successfully');

						packages.relationships.push(relationships);
						next(null);
					})
					.catch(error => {
						logger.log('error', prepareError(error), 'Error retrieving schema');
						next(prepareError(error));
					});
			},
			err => {
				logger.progress({ message: 'Reverse-engineering completed', containerName: '', entityName: '' });
				logger.log('info', '', 'Reverse-engineering completed');

				setTimeout(() => {
					cb(err, packages.labels, modelProps, [].concat.apply([], packages.relationships));
				}, 1000);
			},
		);
	},
};

const initDependencies = app => {
	setDependencies(app);
	_ = dependencies.lodash;
	async = dependencies.async;
	neo4j.setDependencies(dependencies);
};

const getSampleDocSize = (count, recordSamplingSettings) => {
	if (recordSamplingSettings.active === 'absolute') {
		return Number(recordSamplingSettings.absolute.value);
	}

	const limit = Math.ceil((count * recordSamplingSettings.relative.value) / 100);

	return Math.min(limit, recordSamplingSettings.maxValue);
};

const isEmptyLabel = documents => {
	if (!Array.isArray(documents)) {
		return true;
	}

	return documents.reduce((result, doc) => result && _.isEmpty(doc), true);
};

const getTemplate = documents => {
	return documents.reduce((tpl, doc) => _.merge(tpl, doc), {});
};

const checkConnection = logger => (host, port) => {
	return logHelper.checkConnection(host, port).then(
		() => {
			logger.log('info', 'Socket ' + host + ':' + port + ' is available.', 'Host availability');
		},
		error => {
			const errorMessage = 'Socket ' + host + ':' + port + ' is not available.';
			logger.log('error', prepareError(error), errorMessage, 'Host availability');
			throw new Error(errorMessage);
		},
	);
};

const logInfo = (step, connectionInfo, logger) => {
	logger.clear();
	logger.log('info', logHelper.getSystemInfo(connectionInfo.appVersion), step);
	logger.log('info', connectionInfo, 'connectionInfo', connectionInfo.hiddenKeys);
};

const getNodesData = (dbName, labels, isMultiDb, data, logger) => {
	return new Promise((resolve, reject) => {
		let packages = [];
		async.map(
			labels,
			(labelName, nextLabel) => {
				logger(labelName, 'Getting data...');

				neo4j
					.getNodesCount(labelName, dbName, isMultiDb)
					.then(quantity => {
						const count = getSampleDocSize(quantity, data.recordSamplingSettings);
						logger(labelName, 'Found ' + count + ' nodes');

						return neo4j.getNodes(labelName, count, dbName, isMultiDb);
					})
					.then(documents => {
						logger(labelName, 'Data retrieved successfully');

						const packageData = getLabelPackage(
							dbName,
							labelName,
							documents,
							data.includeEmptyCollection,
							data.fieldInference,
							data.indexes[labelName],
							getConstraintsForEntity(labelName, 'node', data.constraints),
						);
						if (packageData) {
							packages.push(packageData);
						}
						nextLabel(null);
					})
					.catch(nextLabel);
			},
			err => {
				if (err) {
					reject(err);
				} else {
					resolve(packages);
				}
			},
		);
	});
};

const getRelationshipData = (
	schema,
	dbName,
	dbVersion,
	recordSamplingSettings,
	fieldInference,
	metaData,
	isMultiDb,
) => {
	const { constraints, indexes } = metaData;
	return new Promise((resolve, reject) => {
		async.map(
			schema,
			(chain, nextChain) => {
				neo4j
					.getCountRelationshipsData(chain.start, chain.relationship, chain.end, dbName, isMultiDb)
					.then(quantity => {
						const count = getSampleDocSize(quantity, recordSamplingSettings);
						return neo4j.getRelationshipData(
							chain.start,
							chain.relationship,
							chain.end,
							count,
							dbName,
							isMultiDb,
						);
					})
					.then(rawDocuments => {
						const documents = deserializeData(rawDocuments);
						const separatedConstraints = separateConstraintsByType(
							getConstraintsForEntity(chain.relationship, 'relationship', constraints) || [],
						);
						const jsonSchema = createSchemaByConstraints(documents, separatedConstraints);
						const preparedDocuments = documents.map(removeFunctions);

						let packageData = {
							dbName,
							parentCollection: chain.start,
							relationshipName: chain.relationship,
							childCollection: chain.end,
							validation: {
								jsonSchema,
							},
							documents: preparedDocuments,
						};

						if (fieldInference.active === 'field') {
							packageData.documentTemplate = getTemplate(preparedDocuments);
						}

						if (['4.3', '4.4', '5.x'].includes(dbVersion)) {
							packageData.relationshipInfo = { index: indexes[chain.relationship] || [] };
						}

						nextChain(null, packageData);
					})
					.catch(nextChain);
			},
			(err, packages) => {
				if (err) {
					reject(err);
				} else {
					resolve(packages);
				}
			},
		);
	});
};

const getLabelPackage = (
	dbName,
	labelName,
	rawDocuments,
	includeEmptyCollection,
	fieldInference,
	indexes,
	constraints,
) => {
	const documents = deserializeData(rawDocuments);
	const separatedConstraints = separateConstraintsByType(constraints);
	const jsonSchema = createSchemaByConstraints(documents, separatedConstraints);
	const preparedDocuments = documents.map(removeFunctions);

	let packageData = {
		dbName: dbName,
		collectionName: labelName,
		documents: preparedDocuments,
		indexes: [],
		bucketIndexes: [],
		views: [],
		validation: { jsonSchema },
		emptyBucket: false,
		bucketInfo: {},
		entityLevel: {
			constraint: separatedConstraints['NODE_KEY'],
			index: indexes,
		},
	};

	if (fieldInference.active === 'field') {
		packageData.documentTemplate = getTemplate(preparedDocuments);
	}

	if (includeEmptyCollection || !isEmptyLabel(preparedDocuments)) {
		return packageData;
	} else {
		return null;
	}
};

const prepareIndexes3x = indexes => {
	const hasProperties = /INDEX\s+ON\s+\:(.*)\((.*)\)/i;
	const map = {};

	indexes.forEach((index, i) => {
		if (!index.properties) {
			if (hasProperties.test(index.description)) {
				const parsedDescription = index.description.match(hasProperties);
				index.label = parsedDescription[1];
				index.properties = parsedDescription[2].split(',').map(s => s.trim());
			} else {
				index.properties = [];
			}
		}

		if (!map[index.label]) {
			map[index.label] = [];
		}

		map[index.label].push({
			name: `${index.label}.[${index.properties.join(',')}]`,
			key: index.properties,
			state: index.state,
			type: index.type,
			provider: JSON.stringify(index.provider, null, 4),
		});
	});

	return map;
};

const prepareIndexes4x = indexes => {
	let map = {};
	indexes
		.filter(index => index.labelsOrTypes)
		.forEach((index, i) => {
			index.properties = index.properties || [];

			const index_obj = {
				name: index.name,
				key: index.properties,
				state: index.state,
				type: index.type,
				uniqueness: index.uniqueness === 'UNIQUE',
				provider: index.provider || index.indexProvider,
			};

			index.labelsOrTypes.forEach((label, i) => {
				if (!map[label]) {
					map[label] = [index_obj];
				} else {
					map[label].push(index_obj);
				}
			});
		});
	return map;
};

const prepareConstraints = (constraints, dbVersion) => {
	if (dbVersion === '5.x') {
		return prepareConstraints5x(constraints);
	}
	return prepareConstraints4x(constraints);
};

const prepareConstraints5x = constraints => {
	const mapConstraint = constraint => {
		if (constraint.type === 'UNIQUENESS') {
			return {
				name: constraint.name,
				type: 'UNIQUE',
				key: constraint.properties,
			};
		} else if (constraint.type === 'NODE_KEY') {
			return {
				name: constraint.name,
				type: 'NODE_KEY',
				compositeNodeKey: constraint.properties,
			};
		} else if (['NODE_PROPERTY_EXISTENCE', 'RELATIONSHIP_PROPERTY_EXISTENCE'].includes(constraint.type)) {
			return {
				name: constraint.name,
				type: 'EXISTS',
				key: constraint.properties,
			};
		}
	};

	return constraints.reduce(
		(acc, constraint) => {
			if (!constraint.labelsOrTypes) {
				return acc;
			}
			constraint.labelsOrTypes.forEach(labelName => {
				const entityTypeKey = constraint.entityType === 'NODE' ? 'node' : 'relationship';
				if (!acc[entityTypeKey][labelName]) {
					acc[entityTypeKey][labelName] = [];
				}
				acc[entityTypeKey][labelName].push(mapConstraint(constraint));
			});

			return acc;
		},
		{ node: {}, relationship: {} },
	);
};

const prepareConstraints4x = constraints => {
	const isUnique = /^constraint\s+on\s+\([\s\S]+\:([\S\s]+)\s*\)\s+assert\s+[\s\S]+\.([\s\S]+)\s*\)\s+IS\s+UNIQUE/i;
	const isNodeKey =
		/^constraint\s+on\s+\([\s\S]+\:\s*([\S\s]+)\s*\)\s+assert\s+(?:\(\s*([\s\S]+)\s*\)|[\s\S]+\.\s*([\S\s]+)\s*)\s+IS\s+NODE\s+KEY/i;
	const isExists = /^constraint\s+on\s+\([\s\S]+\:([\s\S]+)\s*\)\s+assert\s+exists\([\s\S]+\.([\s\S]+)\s*\)/i;
	let result = { nodeAndRelationship: {} };
	const addToResult = (result, name, label, key, type, keyName = 'key') => {
		const labelName = label.trim();
		if (!result.nodeAndRelationship[labelName]) {
			result.nodeAndRelationship[labelName] = [];
		}

		result.nodeAndRelationship[labelName].push({ [keyName]: key, name, type });
	};

	constraints.forEach(c => {
		const constraint = c.description.trim();

		if (isUnique.test(constraint)) {
			let data = constraint.match(isUnique);
			let label = data[1];
			let field = data[2];

			addToResult(result, `Unique ${label}.${field}`, label, [field], 'UNIQUE');
		} else if (isExists.test(constraint)) {
			let data = constraint.match(isExists);
			let label = data[1];
			let field = data[2];

			addToResult(result, `Required ${label}.${field}`, label, [field], 'EXISTS');
		} else if (isNodeKey.test(constraint)) {
			let data = constraint.match(isNodeKey);
			let label = data[1];
			let fields = [];

			if (data[2]) {
				fields = data[2].split(',').map(s => {
					const field = s.trim().match(/[\s\S]+\.([\s\S]+)/);

					if (field) {
						return field[1].trim();
					} else {
						return s;
					}
				});
			} else if (data[3]) {
				fields = [data[3].trim()];
			}

			if (fields.length) {
				addToResult(result, `${label}`, label, fields, 'NODE_KEY', 'compositeNodeKey');
			}
		}
	});

	return result;
};

const prepareError = error => {
	return {
		message: error.message,
		stack: error.stack,
	};
};

const deserializeData = documents => {
	const deserializeObject = value => {
		try {
			return JSON.parse(value);
		} catch (e) {
			return value;
		}
	};
	const handleField = value => {
		if (typeof value === 'string') {
			return deserializeObject(value);
		} else if (Array.isArray(value)) {
			return value.map(handleField);
		} else {
			return value;
		}
	};
	const deserializator = document => {
		let newDocument = {};

		for (let field in document) {
			newDocument[field] = handleField(document[field]);
		}

		return newDocument;
	};

	return Array.isArray(documents)
		? documents.map(document => (typeof document === 'object' ? deserializator(document) : {}))
		: [];
};

const createSchemaByConstraints = (documents, constraints) => {
	let jsonSchema = constraints['EXISTS'].reduce(
		(jsonSchema, constraint) => {
			jsonSchema.required = jsonSchema.required.concat(constraint.key);
			return jsonSchema;
		},
		{ required: [], properties: {} },
	);
	jsonSchema = constraints['UNIQUE'].reduce((jsonSchema, constraint) => {
		return constraint.key.reduce((jsonSchema, key) => {
			if (!jsonSchema.properties[key]) {
				jsonSchema.properties[key] = {};
			}
			jsonSchema.properties[key].unique = true;
			return jsonSchema;
		}, jsonSchema);
	}, jsonSchema);

	documents.forEach(document => setDocumentInSchema(document, jsonSchema));

	return jsonSchema;
};

const setDocumentInSchema = (document, jsonSchema) => {
	const has = Function.prototype.call.bind(Object.prototype.hasOwnProperty);

	Object.keys(document).forEach(fieldName => {
		const value = document[fieldName];

		if (Array.isArray(value)) {
			const items = getSchemaArrayItems(value);
			if (items.length) {
				if (!has(jsonSchema.properties || {}, fieldName)) {
					jsonSchema.properties[fieldName] = {
						type: 'list',
						items,
					};
				}
			}
		} else if (Object(value) === value) {
			if (!has(jsonSchema.properties || {}, fieldName)) {
				if (value.srid) {
					jsonSchema.properties[fieldName] = getSchemaSpatialType(value);
				} else if (neo4j.isTemporalTypeField(value)) {
					jsonSchema.properties[fieldName] = neo4j.getTemporalFieldSchema(value);
					if (typeof document[fieldName]?.toString === 'function') {
						document[fieldName] = document[fieldName].toString();
					}
				} else {
					jsonSchema.properties[fieldName] = setDocumentInSchema(value, { properties: {} });
				}
			}
			if (value.srid) {
				delete document[fieldName];
			}
		} else if (typeof value === 'number') {
			if (!has(jsonSchema.properties || {}, fieldName)) {
				jsonSchema.properties[fieldName] = {
					type: 'number',
					mode: value % 1 === 0 ? 'integer' : 'float',
					sample: value,
				};
			}
		}
	});

	return jsonSchema;
};

const getSchemaArrayItems = arrValue => {
	const items = [];
	let ofs = 0;

	[...arrValue].forEach((item, i) => {
		if (_.isPlainObject(item) && item.srid) {
			items.push(getSchemaSpatialType(item));
			arrValue.splice(i - ofs, 1);
			ofs++;
		} else if (Array.isArray(item)) {
			items.push({
				type: 'list',
				items: getSchemaArrayItems(item),
			});
		} else if (typeof item === 'number') {
			items.push({
				type: 'number',
				mode: item % 1 === 0 ? 'integer' : 'float',
				sample: item,
			});
			arrValue.splice(i - ofs, 1);
			ofs++;
		}
	});

	return items;
};

const getSchemaSpatialType = value => {
	switch (Number(value.srid)) {
		case 4326:
			return {
				type: 'spatial',
				mode: 'point',
				subType: 'WGS-84',
				properties: getSnippetPropertiesByName('WGS-84'),
			};
		case 4979:
			return {
				type: 'spatial',
				mode: 'point',
				subType: 'WGS-84-3D',
				properties: getSnippetPropertiesByName('WGS-84-3D'),
			};
		case 7203:
			return {
				type: 'spatial',
				mode: 'point',
				subType: 'Cartesian',
				properties: getSnippetPropertiesByName('Cartesian'),
			};
		case 9157:
			return {
				type: 'spatial',
				mode: 'point',
				subType: 'Cartesian 3D',
				properties: getSnippetPropertiesByName('Cartesian 3D'),
			};
	}
};

const getSnippetPropertiesByName = name => {
	const snippet = snippets[name] || snippets['WGS-84'];
	const properties = {};

	snippet.properties.forEach(fieldSchema => {
		properties[fieldSchema.name] = Object.assign({}, fieldSchema);
		delete properties[fieldSchema.name].name;
	});

	return properties;
};

const separateConstraintsByType = (constraints = []) => {
	return constraints.reduce(
		(result, constraint) => {
			constraint = Object.assign({}, constraint);
			const type = constraint.type;
			delete constraint.type;
			result[type].push(constraint);

			return result;
		},
		{ 'UNIQUE': [], 'EXISTS': [], 'NODE_KEY': [] },
	);
};

const getConstraintsForEntity = (entityName, entityType, constraints) => {
	if (constraints.nodeAndRelationship) {
		return constraints.nodeAndRelationship[entityName];
	}
	return constraints[entityType]?.[entityName];
};

const removeFunctions = document => {
	try {
		return JSON.parse(
			JSON.stringify(document, (key, value) => {
				if (typeof value === 'object' && neo4j.isTemporalTypeField(value)) {
					return value.toString();
				}
				return value;
			}),
		);
	} catch (e) {
		return document;
	}
};
