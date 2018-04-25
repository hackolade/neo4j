module.exports = {
	generateContainerScript(data, logger, cb) {
		let { collections, relationships, jsonData } = data;
		logger.clear();
		try {
			collections = collections.map(JSON.parse);
			relationships = relationships.map(JSON.parse);

			const createScript = this.generateCreateBatch(collections, relationships, jsonData);

			cb(null, createScript);
		} catch(e) {
			logger.log('error', { message: e.message, stack: e.stack }, 'Forward-Engineering Error');
			setTimeout(() => {
				cb({ message: e.message, stack: e.stack });
			}, 150);
			return;
		}
	},

	generateCreateBatch(collections, relationships, jsonData) {
		let createdHash = {};

		let labels = this.createMap(collections, relationships).reduce((batch, branchData) => {
			let branch = '';

			let parent = '';
			let child = '';
			let relationship = '';

			let parentName = '';
			let childName = '';
			let relationshipName = '';
			
			let relationshipData = '';
			let childData = '';

			parentName = branchData.parent.collectionName;

			if (createdHash[parentName]) {
				parent = `(${parentName.toLowerCase()})`;
			} else {
				let parentData = '';
				if (jsonData[branchData.parent.GUID]) {
					parentData = ' ' + this.prepareData(jsonData[branchData.parent.GUID]);
				}
	
				parent = `(${parentName.toLowerCase()}:\`${parentName}\`${parentData})`;
				createdHash[parentName] = true;
			}

			if (branchData.relationship && branchData.child) {
				relationshipName = branchData.relationship.name;			
				if (branchData.relationship && jsonData[branchData.relationship.GUID]) {
					relationshipData = ' ' + this.prepareData(jsonData[branchData.relationship.GUID]);
				}
				relationship = `[:\`${relationshipName}\`${relationshipData}]`;

				childName = branchData.child.collectionName;
				if (createdHash[childName]) {
					child = `(${childName.toLowerCase()})`;
				} else {
					if (branchData.child && jsonData[branchData.child.GUID]) {
						childData = ' ' + this.prepareData(jsonData[branchData.child.GUID]);
					}
					child = `(${childName.toLowerCase()}:\`${childName}\`${childData})`;
					createdHash[childName] = true;
				}

				batch.push(`${parent}-${relationship}->${child}`);

				if (branchData.bidirectional) {
					batch.push(`(${childName.toLowerCase()})-${relationship}->(${parentName.toLowerCase()})`);
				}
			} else {
				batch.push(parent);
			}

			return batch;
		}, []).join(',\n');

		let script = `CREATE ${labels}`;

		if (Object.keys(createdHash).length) {
			script +=  ` RETURN ${Object.keys(createdHash).join(',').toLowerCase()}`;
		}

		return script;
	},

	prepareData(serializedData) {
		const data = JSON.parse(serializedData);
		return '{ ' + Object.keys(data).reduce((result, field) => {
			if (typeof data[field] === 'object' && !Array.isArray(data[field])) {
				result.push(`\`${field}\`: apoc.convert.toJson(${this.toCypherJson(data[field])})`);
			} else {
				result.push(`\`${field}\`: ${JSON.stringify(data[field])}`);
			}

			return result;
		}, []).join(', ') + ' }';
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

		return collections.map(collection => {
			collectionMap[collection.GUID] = collection;
			return collection;
		}).reduce((map, parent) => {
			const relationships = relationshipMap[parent.GUID] || null;

			if (relationships) {
				relationships.forEach(relationship => {
					const child = collectionMap[relationship.childCollection];
					map.push({
						parent,
						relationship,
						child,
						bidirectional: (relationship && relationship.customProperties && relationship.customProperties.biDirectional && child.GUID !== parent.GUID)
					});
				});
			} else if (!hasRelationship[parent.GUID]) {
				map.push({
					parent,
					relationship: null,
					child: null,
					bidirectional: false
				});
			}

			return map;
		}, []);
	},

	toCypherJson(data) {
		if (typeof data === 'object' && !Array.isArray(data)) {
			return '{ ' + Object.keys(data).reduce((result, field) => {
				result.push(`\`${field}\`: ${this.toCypherJson(data[field])}`);
				return result;
			}, []).join(', ') + ' }';
		} else {
			return JSON.stringify(data);
		}
	},

	generateConstraints(collections) {
		collections.reduce((result, collection) => {
			if (collection.constraint && Array.isArray(collection.constraint)) {
				collection.constraint.forEach(constraint => {
					result.push(this.getConstraint(collection, constraint));
				});
			}

			return result;
		}, []);
	},

	getConstraint(collection, constraint) {
		let keys = [];
		if (constraint.key) {
			keys = this.findFields(collection, constraint.key.map(key => key.key));
		}
		if (constraint.type === 'NODE KEY') {

		} else if (constraint.type === 'EXISTS') {

		} else {

		}
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
				if (fields.indexOf(field.name) === -1) {
					fields.push(field.name);
				}
				ids.splice(indexId, 1);
			}

			if (field.properties || field.items) {
				const fieldsAreFound = this.findFields(field, ids);

				if (fieldsAreFound.length && fields.indexOf(field.name) === -1) {
					fields.push(field.name);
				}
			}

			if (!ids.length) {
				return fields;
			}

		}

		return fields;
	}
};
