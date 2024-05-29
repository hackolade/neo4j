const { dependencies, setDependencies } = require('./helpers/appDependencies');
const applyToInstanceHelper = require('./helpers/applyToInstance');
let _;
const setAppDependencies = ({ lodash }) => (_ = lodash);

module.exports = {
	generateContainerScript(data, logger, cb, app) {
		setDependencies(app);
		setAppDependencies(dependencies);
		let { collections, relationships, jsonData } = data;
		const dbVersion = data.modelData[0]?.dbVersion;
		logger.clear();
		try {
			collections = collections.map(JSON.parse);
			relationships = relationships.map(JSON.parse);

			const createScript = this.generateCreateBatch(collections, relationships, jsonData, logger);
			const constraints = this.generateConstraints(dbVersion, collections, relationships);
			const indexes = this.getIndexes(dbVersion, collections, relationships);

			cb(null, this.getScript(createScript, constraints, indexes, dbVersion));
		} catch (e) {
			logger.log('error', { message: e.message, stack: e.stack }, 'Forward-Engineering Error');
			setTimeout(() => {
				cb({ message: e.message, stack: e.stack });
			}, 150);
			return;
		}
	},

	getScript(createScript, constraints, indexes, dbVersion) {
		const getTransaction = script => {
			return ':begin\n' + script + ';\n:commit\n';
		};
		let script = getTransaction(
			'// cat <path to cypher file> | ./bin/cypher-shell -a <address> -u <user> -p <password>\n\n' + createScript,
		);

		if (Array.isArray(constraints) && constraints.length) {
			script += getTransaction(constraints.join(';\n'));
		}

		if (Array.isArray(indexes) && indexes.length) {
			script += getTransaction(indexes.join(';\n'));
		}

		return script;
	},

	generateCreateBatch(collections, relationships, jsonData, logger) {
		let createdHash = {};

		const initBatch = collections.map(collection => {
			createdHash[collection.collectionName] = collection.isActivated;
			let nodeData = '';
			if (jsonData[collection.GUID]) {
				nodeData =
					' ' + this.prepareData(jsonData[collection.GUID], collection, collection.isActivated, logger);
			}

			const collectionString = `(${screen(collection.collectionName).toLowerCase()}:${screen(
				collection.collectionName,
			)}${nodeData})`;
			return { statement: collectionString + ',', isActivated: collection.isActivated };
		});

		let labels = this.createMap(collections, relationships).reduce((batch, branchData) => {
			if (branchData.relationship && branchData.child) {
				let parentName = branchData.parent.collectionName;
				let childName = branchData.child.collectionName;
				let relationshipName = branchData.relationship.name;
				let relationshipData = '';

				const isParentActivated = _.get(branchData, 'parent.isActivated', true);
				const isChildActivated = _.get(branchData, 'child.isActivated', true);
				const isActivated = isParentActivated && isChildActivated;

				const parent = `(${screen(parentName).toLowerCase()})`;
				const child = `(${screen(childName).toLowerCase()})`;

				if (branchData.relationship && jsonData[branchData.relationship.GUID]) {
					relationshipData =
						' ' +
						this.prepareData(
							jsonData[branchData.relationship.GUID],
							branchData.relationship,
							isActivated,
							logger,
						);
				}
				const relationship = `[:${screen(relationshipName)}${relationshipData}]`;

				batch.push({ statement: `${parent}-${relationship}->${child},`, isActivated: isActivated });

				if (branchData.bidirectional) {
					batch.push({
						statement: `(${screen(childName).toLowerCase()})-${relationship}->(${screen(
							parentName,
						).toLowerCase()}),`,
						isActivated: isActivated,
					});
				}
			}

			return batch;
		}, initBatch);

		const activatedLabels = labels
			.filter(label => label.isActivated)
			.map(label => label.statement)
			.join('\n\n')
			.slice(0, -1);
		const deactivatedLabels = labels
			.filter(label => !label.isActivated)
			.map(label => label.statement)
			.join('\n\n')
			.slice(0, -1);

		let script = `CREATE ${
			activatedLabels +
			(deactivatedLabels.length ? '\n\n' + this.commentIfDeactivated(deactivatedLabels, false) : '')
		}`;

		if (Object.keys(createdHash).length) {
			script += `\n RETURN ${Object.keys(createdHash)
				.filter(key => createdHash[key])
				.map(screen)
				.join(',')
				.toLowerCase()}`;
		}

		return script;
	},

	applyToInstance(connectionInfo, logger, callback, app) {
		setDependencies(app);
		logger.clear();
		logger.log('info', connectionInfo, 'connectionInfo', connectionInfo.hiddenKeys);

		applyToInstanceHelper
			.applyToInstance(connectionInfo, dependencies, logger)
			.then(result => {
				callback(null, result);
			})
			.catch(error => {
				callback({ ...error, type: 'simpleError' });
			});
	},

	testConnection(connectionInfo, logger, callback, app) {
		setDependencies(app);
		logger.log('info', connectionInfo, 'connectionInfo', connectionInfo.hiddenKeys);
		applyToInstanceHelper.testConnection(connectionInfo, dependencies).then(callback, err => {
			logger.log('error', err, 'Neo4j test connection error');
			callback({ ...err, type: 'simpleError' });
		});
	},

	prepareData(serializedData, schema, isParentActivated, logger) {
		const data = JSON.parse(serializedData);
		if (!Object.keys(data).length) {
			return '{}';
		}

		const fields = Object.keys(data).reduce((result, field) => {
			if (Object(data[field]) === data[field] && !Array.isArray(data[field])) {
				const isFieldActivated = _.get(schema, `properties.${field}.isActivated`, true);
				result.push({
					statement: `${screen(field)}: ${this.getObjectValueBySchema(
						data[field],
						getProperty(schema, field),
					)}`,
					isActivated: isParentActivated ? isFieldActivated : true,
				});
			} else if (Array.isArray(data[field])) {
				const isFieldActivated = _.get(schema, `properties.${field}.isActivated`, true);
				result.push({
					statement: `${screen(field)}: [ ${this.getArrayValueBySchema(
						data[field],
						getProperty(schema, field).items || [],
					).join(', ')} ]`,
					isActivated: isParentActivated ? isFieldActivated : true,
				});
			} else {
				const isFieldActivated = _.get(schema, `properties.${field}.isActivated`, true);
				const fieldInSchema =
					_.get(schema, ['properties', field]) || _.get(schema, ['patternProperties', field]);
				if (!fieldInSchema) {
					logger.log('error', "Can't resolve field:\n", { field });
				}
				result.push({
					statement: `${screen(field)}: ${getStatementValue(fieldInSchema, data[field])}`,
					isActivated: isParentActivated ? isFieldActivated : true,
				});
			}

			return result;
		}, []);

		const activatedFields = fields
			.filter(field => field.isActivated)
			.map(field => field.statement)
			.join(',\n\t');
		const deactivatedFields = fields
			.filter(field => !field.isActivated)
			.map(field => field.statement)
			.join(',\n\t');

		return (
			'{\n\t' +
			activatedFields +
			(deactivatedFields.length ? '\n' + this.commentIfDeactivated(deactivatedFields, false) + '\n}' : '\n}')
		);
	},

	createMap(collections, relationships) {
		let relationshipMap = {};
		let hasRelationship = {};
		let collectionMap = {};

		relationships.forEach(relationship => {
			if (!relationshipMap[relationship.parentCollection]) {
				relationshipMap[relationship.parentCollection] = [];
			}
			relationshipMap[relationship.parentCollection].push(relationship);

			hasRelationship[relationship.parentCollection] = true;
			hasRelationship[relationship.childCollection] = true;
		});

		return collections
			.map(collection => {
				collectionMap[collection.GUID] = collection;
				return collection;
			})
			.reduce((map, parent) => {
				const relationships = relationshipMap[parent.GUID] || null;

				if (relationships) {
					relationships.forEach(relationship => {
						const child = collectionMap[relationship.childCollection];
						map.push({
							parent,
							relationship,
							child,
							bidirectional:
								relationship &&
								relationship.customProperties &&
								relationship.customProperties.biDirectional &&
								child.GUID !== parent.GUID,
						});
					});
				} else if (!hasRelationship[parent.GUID]) {
					map.push({
						parent,
						relationship: null,
						child: null,
						bidirectional: false,
					});
				}

				return map;
			}, []);
	},

	toCypherJson(data) {
		if (Object(data) === data && !Array.isArray(data)) {
			return (
				'{ ' +
				Object.keys(data)
					.reduce((result, field) => {
						result.push(`${screen(field)}: ${this.toCypherJson(data[field])}`);
						return result;
					}, [])
					.join(', ') +
				' }'
			);
		} else {
			return JSON.stringify(data);
		}
	},

	generateConstraints(dbVersion, collections, relationships) {
		let result = [];

		const collectionIdToActivated = collections.reduce((result, collection) => {
			result[collection.GUID] = collection.isActivated;
			return result;
		}, {});

		let getExistsConstraint = this.getExistsConstraint;
		if (!isDBVersionLessThan4point3(dbVersion)) {
			getExistsConstraint = this.getExistsConstraint43;
		}

		collections.forEach(collection => {
			if (collection.constraint && Array.isArray(collection.constraint)) {
				collection.constraint.forEach(constraint => {
					const nodeKeyConstraint = this.getNodeKeyConstraint({ collection, constraint }, dbVersion);
					if (nodeKeyConstraint) {
						result.push(nodeKeyConstraint);
					}
				});
			}
			if (Array.isArray(collection.required)) {
				collection.required.forEach(fieldName => {
					if (fieldName) {
						const isFieldActivated = _.get(collection, `properties.${fieldName}.isActivated`, true);
						result.push(
							this.commentIfDeactivated(
								getExistsConstraint(
									{ labelName: collection.collectionName, fieldName, type: 'node' },
									dbVersion,
								),
								collection.isActivated && isFieldActivated,
							),
						);
					}
				});
			}
			if (collection.properties) {
				Object.keys(collection.properties).forEach(fieldName => {
					if (collection.properties[fieldName].unique) {
						const isFieldActivated = _.get(collection, `properties.${fieldName}.isActivated`, true);
						result.push(
							this.commentIfDeactivated(
								this.getUniqueConstraint(
									{ labelName: collection.collectionName, fieldName },
									dbVersion,
								),
								collection.isActivated && isFieldActivated,
							),
						);
					}
				});
			}
		});

		relationships.forEach(relationship => {
			const isRelationshipActivated =
				collectionIdToActivated[relationship.childCollection] &&
				collectionIdToActivated[relationship.parentCollection];
			if (Array.isArray(relationship.required)) {
				relationship.required.forEach(fieldName => {
					if (fieldName) {
						const isFieldActivated = _.get(relationship, `properties.${fieldName}.isActivated`, true);
						result.push(
							this.commentIfDeactivated(
								getExistsConstraint(
									{ labelName: relationship.name, fieldName, type: 'relationship' },
									dbVersion,
								),
								isFieldActivated && isRelationshipActivated,
							),
						);
					}
				});
			}
		});

		return result;
	},

	getNodeKeyConstraint({ collection, constraint }, dbVersion) {
		let keys = [];
		if (constraint.compositeNodeKey) {
			keys = this.findFields(
				collection,
				constraint.compositeNodeKey.map(key => key.keyId),
			);
			const statementConfig = getConstraintStatementConfig(dbVersion);
			if (Array.isArray(keys) && keys.length) {
				const labelName = collection.collectionName;
				const varLabelName = collection.collectionName.toLowerCase();
				const idempotentConstraintStatement = getOptionalIdempotentConstraintStatement(dbVersion);

				return this.commentIfDeactivated(
					`CREATE CONSTRAINT ${constraint.name ? screen(constraint.name) : ''}${idempotentConstraintStatement}${statementConfig.FOR} (${screen(varLabelName)}:${screen(labelName)}) ${statementConfig.REQUIRED} (${keys
						.map(key => `${screen(varLabelName)}.${screen(key.name)}`)
						.join(', ')}) IS NODE KEY`,
					keys.every(key => key.isActivated),
				);
			}
		}
	},

	getExistsConstraint({ labelName, fieldName, type }) {
		const varLabelName = labelName.toLowerCase();
		switch (type) {
			case 'node':
				return `CREATE CONSTRAINT ON (${screen(varLabelName)}:${screen(labelName)}) ASSERT exists(${screen(varLabelName)}.${screen(fieldName)})`;
			case 'relationship':
				return `CREATE CONSTRAINT ON ()-[${screen(varLabelName)}:${screen(labelName)}]-() ASSERT exists(${screen(varLabelName)}.${screen(fieldName)})`;
			default:
				return null;
		}
	},

	getExistsConstraint43({ labelName, fieldName, type }, dbVersion) {
		const statementConfig = getConstraintStatementConfig(dbVersion);
		const varLabelName = labelName.toLowerCase();
		switch (type) {
			case 'node':
				return `CREATE CONSTRAINT IF NOT EXISTS ${statementConfig.FOR} (${screen(varLabelName)}:${screen(labelName)}) ${statementConfig.REQUIRED} ${screen(varLabelName)}.${screen(fieldName)} IS NOT NULL`;
			case 'relationship':
				return `CREATE CONSTRAINT IF NOT EXISTS ${statementConfig.FOR} ()-[${screen(varLabelName)}:${screen(labelName)}]-() ${statementConfig.REQUIRED} ${screen(varLabelName)}.${screen(fieldName)} IS NOT NULL`;
			default:
				return null;
		}
	},

	getUniqueConstraint({ labelName, fieldName }, dbVersion) {
		const statementConfig = getConstraintStatementConfig(dbVersion);
		const varLabelName = labelName.toLowerCase();
		const idempotentConstraintStatement = getOptionalIdempotentConstraintStatement(dbVersion);
		return `CREATE CONSTRAINT${idempotentConstraintStatement}${statementConfig.FOR} (${screen(varLabelName)}:${screen(labelName)}) ${statementConfig.REQUIRED} ${screen(
			varLabelName,
		)}.${screen(fieldName)} IS UNIQUE`;
	},

	findFields(collection, ids) {
		let fields = [];
		let properties;

		if (collection.items) {
			if (Array.isArray(collection.items)) {
				properties = collection.items;
			} else {
				properties = [collection.items];
			}
		} else {
			properties = collection.properties;
		}

		for (let fieldName in properties) {
			const field = properties[fieldName];
			const indexId = ids.indexOf(field.GUID);
			if (indexId !== -1) {
				if (fields.indexOf(fieldName) === -1) {
					fields.push({ name: fieldName, isActivated: field.isActivated });
				}
				ids.splice(indexId, 1);
			}

			if (field.properties || field.items) {
				const fieldsAreFound = this.findFields(field, ids);

				if (fieldsAreFound.length && fields.indexOf(field.name) === -1) {
					fields.push({ name: field.name, isActivated: field.isActivated });
				}
			}

			if (!ids.length) {
				return fields;
			}
		}

		return fields;
	},

	getIndexes(dbVersion, collections, relationships) {
		let result = [];
		let getIndex = this.getIndex3x.bind(this);
		let entities = { collections };
		if (dbVersion !== '3.x') {
			getIndex = this.getIndex4x.bind(this);
			if (['4.3', '4.4', '5.x'].includes(dbVersion)) {
				entities.relationships = relationships;
			}
		}
		Object.keys(entities).forEach(type => {
			entities[type].forEach(entity => {
				if (entity.index) {
					entity.index.forEach(index => {
						if (index.key) {
							const fields = this.findFields(
								entity,
								index.key.map(key => key.keyId),
							);
							if (fields.length) {
								const indexScript = getIndex({
									entity,
									index,
									fields,
									isActivated: index.isActivated !== false && entity.isActivated !== false,
									type,
									dbVersion,
								});
								result.push(indexScript);
							}
						}
					});
				}
			});
		});

		return result;
	},

	getIndex3x({ entity, fields, isActivated }) {
		return this.commentIfDeactivated(
			`CREATE INDEX ON :${screen(entity.collectionName)}(${fields.map(field => screen(field.name)).join(', ')})`,
			isActivated && fields.every(field => field.isActivated),
		);
	},

	getIndex4x({ entity, index, fields, isActivated, type, dbVersion }) {
		const name = (entity.name || entity.collectionName)?.toLowerCase() || 'entity';
		const indexType = this.getIndexType(index, dbVersion);
		const indexTypeStatement = indexType ? ` ${indexType} ` : ' ';

		switch (type) {
			case 'collections':
				return this.commentIfDeactivated(
					`CREATE${indexTypeStatement}INDEX ${screen(index.name || name)} IF NOT EXISTS FOR (${screen(name)}:${screen(entity.collectionName)}) ON (${screen(name)}.${fields.map(field => screen(field.name)).join(`, ${screen(name)}.`)})`,
					isActivated && fields.every(field => field.isActivated),
				);
			case 'relationships':
				return this.commentIfDeactivated(
					`CREATE${indexTypeStatement}INDEX ${screen(index.name || name)} IF NOT EXISTS FOR ()-[${screen(name)}:${screen(entity.name)}]-() ON (${screen(name)}.${fields.map(field => screen(field.name)).join(`, ${screen(name)}.`)})`,
					isActivated && fields.every(field => field.isActivated),
				);
		}
		return null;
	},

	getIndexType(index, dbVersion) {
		if (dbVersion === '5.x') {
			return index.type || '';
		}
		return '';
	},

	getObjectValueBySchema(data, fieldSchema) {
		if (fieldSchema && fieldSchema.type === 'spatial') {
			if (fieldSchema.mode === 'point') {
				return `point(${this.toCypherJson(this.fixPoint(data))})`;
			}
		}

		return `apoc.convert.toJson(${this.toCypherJson(data)})`;
	},

	fixPoint(point) {
		const isObject = point && typeof point === 'object' && !Array.isArray(point);
		if (!isObject) {
			return point;
		}

		const fix = num => {
			if (isNaN(num)) {
				return num;
			}

			if (Number(num) > 90) {
				return 90;
			}

			if (Number(num) < -90) {
				return -90;
			}

			return Number(num);
		};

		let newPoint = { ...point };

		if (newPoint.longitude !== undefined) {
			newPoint.longitude = fix(newPoint.longitude);
		}

		if (newPoint.latitude !== undefined) {
			newPoint.latitude = fix(newPoint.latitude);
		}

		return newPoint;
	},

	getArrayValueBySchema(data, arraySchema) {
		return data.map((item, i) => {
			if (Object(item) === item && !Array.isArray(item)) {
				return this.getObjectValueBySchema(item, Array.isArray(arraySchema) ? arraySchema[i] : arraySchema);
			} else if (Array.isArray(item)) {
				return `[ ${this.getArrayValueBySchema(
					item,
					(Array.isArray(arraySchema) ? arraySchema[i] : arraySchema).items,
				).join(', ')} ]`;
			} else {
				return JSON.stringify(item);
			}
		});
	},

	commentIfDeactivated(statement, isActivated) {
		if (!isActivated && !statement.includes('\n')) {
			return `// ${statement}`;
		}
		if (!isActivated) {
			const splittedStatement = statement.split(/\n/);
			return splittedStatement.reduce((result, statement) => result + `// ${statement}\n`, '');
		}

		return statement;
	},
};

const screen = s => `\`${s}\``;

const getProperty = (schema, field) => {
	setAppDependencies(dependencies);
	if (_.has(schema, `properties.${field}`)) {
		return schema.properties[field];
	} else if (_.has(schema, `allOf.${field}`)) {
		return schema.allOf[field];
	} else if (_.has(schema, `anyOf.${field}`)) {
		return schema.anyOf[field];
	} else if (_.has(schema, `oneOf.${field}`)) {
		return schema.oneOf[field];
	} else {
		return {};
	}
};

const getOptionalIdempotentConstraintStatement = dbVersion => {
	if (isDBVersionLessThan4point3(dbVersion)) {
		return ' ';
	}
	return ' IF NOT EXISTS ';
};

const isDBVersionLessThan4point3 = dbVersion => {
	return ['3.x', '4.0-4.2'].includes(dbVersion);
};

const getStatementValue = (field, fieldData) => {
	const fieldStatementValue = JSON.stringify(fieldData);
	if (!field) {
		return fieldStatementValue;
	}
	if ([field.type, field.childType].includes('temporal')) {
		return getTemporalFieldFunctionStatement(field.mode, fieldStatementValue);
	}
	return fieldStatementValue;
};

const getTemporalFieldFunctionStatement = (fieldMode, fieldStatementValue) => {
	const temporalTypeDefaultSampleValue = '2014-12-03';
	const isDefaultSample = fieldStatementValue === JSON.stringify(temporalTypeDefaultSampleValue);

	const durationSampleValue = JSON.stringify('P1D');
	const timeSampleValue = JSON.stringify('12:00');

	switch (fieldMode) {
		case 'date':
			return `date(${fieldStatementValue})`;
		case 'datetime':
			return `datetime(${fieldStatementValue})`;
		case 'localdatetime':
			return `localdatetime(${fieldStatementValue})`;
		case 'localtime':
			const localTimeStatementValue = isDefaultSample ? timeSampleValue : fieldStatementValue;
			return `localtime(${localTimeStatementValue})`;
		case 'time':
			const timeStatementValue = isDefaultSample ? timeSampleValue : fieldStatementValue;
			return `time(${timeStatementValue})`;
		case 'duration':
			const durationStatementValue = isDefaultSample ? durationSampleValue : fieldStatementValue;
			return `duration(${durationStatementValue})`;
		default:
			return fieldStatementValue;
	}
};

const getConstraintStatementConfig = dbVersion => {
	if (dbVersion === '5.x') {
		return {
			FOR: 'FOR',
			REQUIRED: 'REQUIRE',
		};
	}
	return {
		FOR: 'ON',
		REQUIRED: 'ASSERT',
	};
};
