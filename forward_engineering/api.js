const { dependencies, setDependencies } = require('./helpers/appDependencies');
let _;
const setAppDependencies = ({ lodash }) => (_ = lodash);

module.exports = {
    generateContainerScript(data, logger, cb, app) {
        setDependencies(app);
        setAppDependencies(dependencies);
        let { collections, relationships, jsonData } = data;
        logger.clear();
        try {
            collections = collections.map(JSON.parse);
            relationships = relationships.map(JSON.parse);

            const createScript = this.generateCreateBatch(collections, relationships, jsonData);
            const constraints = this.generateConstraints(collections, relationships);
            const indexes = this.getIndexes(collections);

            cb(null, this.getScript(createScript, constraints, indexes));
        } catch (e) {
            logger.log('error', { message: e.message, stack: e.stack }, 'Forward-Engineering Error');
            setTimeout(() => {
                cb({ message: e.message, stack: e.stack });
            }, 150);
            return;
        }
    },

    getScript(createScript, constraints, indexes) {
        const getTransaction = (script) => ':begin\n' + script + ';\n:commit\n';
        let script = getTransaction(
            '// cat <path to cypher file> | ./bin/cypher-shell -a <address> -u <user> -p <password>\n\n' + createScript
        );

        if (Array.isArray(constraints) && constraints.length) {
            script += getTransaction(constraints.join(';\n'));
        }

        if (Array.isArray(indexes) && indexes.length) {
            script += getTransaction(indexes.join(';\n'));
        }

        return script;
    },

    generateCreateBatch(collections, relationships, jsonData) {
        let createdHash = {};

        const initBatch = collections.map((collection) => {
            createdHash[collection.collectionName] = collection.isActivated;
            let nodeData = '';
            if (jsonData[collection.GUID]) {
                nodeData = ' ' + this.prepareData(jsonData[collection.GUID], collection, collection.isActivated);
            }

            const collectionString = `(${screen(collection.collectionName).toLowerCase()}:${screen(
                collection.collectionName
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
                        this.prepareData(jsonData[branchData.relationship.GUID], branchData.relationship, isActivated);
                }
                const relationship = `[:${screen(relationshipName)}${relationshipData}]`;

                batch.push({ statement: `${parent}-${relationship}->${child},`, isActivated: isActivated });

                if (branchData.bidirectional) {
                    batch.push({
                        statement: `(${screen(childName).toLowerCase()})-${relationship}->(${screen(
                            parentName
                        ).toLowerCase()}),`,
                        isActivated: isActivated,
                    });
                }
            }

            return batch;
        }, initBatch);

        const activatedLabels = labels
            .filter((label) => label.isActivated)
            .map((label) => label.statement)
            .join('\n\n')
            .slice(0, -1);
        const deactivatedLabels = labels
            .filter((label) => !label.isActivated)
            .map((label) => label.statement)
            .join('\n\n')
            .slice(0, -1);

        let script = `CREATE ${activatedLabels + (deactivatedLabels.length ? '\n\n' + this.commentIfDeactivated(deactivatedLabels, false) : '')}` ;

        if (Object.keys(createdHash).length) {
            script += `\n RETURN ${Object.keys(createdHash)
                .filter((key) => createdHash[key])
                .map(screen)
                .join(',')
                .toLowerCase()}`;
        }

        return script;
    },

    prepareData(serializedData, schema, isParentActivated) {
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
                        schema.properties[field]
                    )}`,
                    isActivated: isParentActivated ? isFieldActivated : true,
                });
            } else if (Array.isArray(data[field])) {
                const isFieldActivated = _.get(schema, `properties.${field}.isActivated`, true);
                result.push({
                    statement: `${screen(field)}: [ ${this.getArrayValueBySchema(
                        data[field],
                        schema.properties[field].items
                    ).join(', ')} ]`,
                    isActivated: isParentActivated ? isFieldActivated : true,
                });
            } else {
                const isFieldActivated = _.get(schema, `properties.${field}.isActivated`, true);
                result.push({
                    statement: `${screen(field)}: ${JSON.stringify(data[field])}`,
                    isActivated: isParentActivated ? isFieldActivated : true,
                });
            }

            return result;
        }, []);

        const activatedFields = fields
            .filter((field) => field.isActivated)
            .map((field) => field.statement)
            .join(',\n\t');
        const deactivatedFields = fields
            .filter((field) => !field.isActivated)
            .map((field) => field.statement)
            .join(',\n\t');
        console.log(`deactivatedFields: '${deactivatedFields}'`);

        return '{\n\t' + activatedFields + (deactivatedFields.length
            ? '\n' + this.commentIfDeactivated(deactivatedFields, false) + '\n}'
            : '\n}');
    },

    createMap(collections, relationships) {
        let relationshipMap = {};
        let hasRelationship = {};
        let collectionMap = {};

        relationships.forEach((relationship) => {
            if (!relationshipMap[relationship.parentCollection]) {
                relationshipMap[relationship.parentCollection] = [];
            }
            relationshipMap[relationship.parentCollection].push(relationship);

            hasRelationship[relationship.parentCollection] = true;
            hasRelationship[relationship.childCollection] = true;
        });

        return collections
            .map((collection) => {
                collectionMap[collection.GUID] = collection;
                return collection;
            })
            .reduce((map, parent) => {
                const relationships = relationshipMap[parent.GUID] || null;

                if (relationships) {
                    relationships.forEach((relationship) => {
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

    generateConstraints(collections, relationships) {
        let result = [];

        const collectionIdToActivated = collections.reduce((result, collection) => {
            result[collection.GUID] = collection.isActivated;
            return result;
        }, {});

        collections.forEach((collection) => {
            if (collection.constraint && Array.isArray(collection.constraint)) {
                collection.constraint.forEach((constraint) => {
                    const nodeKeyConstraint = this.getNodeKeyConstraint(collection, constraint);
                    if (nodeKeyConstraint) {
                        result.push(nodeKeyConstraint);
                    }
                });
            }
            if (Array.isArray(collection.required)) {
                collection.required.forEach((fieldName) => {
                    if (fieldName) {
                        const isFieldActivated = _.get(collection, `properties.${fieldName}.isActivated`, true);
                        result.push(
                            this.commentIfDeactivated(
                                this.getExistsConstraint(collection.collectionName, fieldName),
                                collection.isActivated && isFieldActivated
                            )
                        );
                    }
                });
            }
            if (collection.properties) {
                Object.keys(collection.properties).forEach((fieldName) => {
                    if (collection.properties[fieldName].unique) {
                        const isFieldActivated = _.get(collection, `properties.${fieldName}.isActivated`, true);
                        result.push(
                            this.commentIfDeactivated(
                                this.getUniqeConstraint(collection.collectionName, fieldName),
                                collection.isActivated && isFieldActivated
                            )
                        );
                    }
                });
            }
        });

        relationships.forEach((relationship) => {
            const isRelationshipActivated =
                collectionIdToActivated[relationship.childCollection] &&
                collectionIdToActivated[relationship.parentCollection];
            if (Array.isArray(relationship.required)) {
                relationship.required.forEach((fieldName) => {
                    if (fieldName) {
                        const isFieldActivated = _.get(relationship, `properties.${fieldName}.isActivated`, true);
                        result.push(
                            this.commentIfDeactivated(
                                this.getExistsConstraint(relationship.name, fieldName),
                                isFieldActivated && isRelationshipActivated
                            )
                        );
                    }
                });
            }

            if (relationship.properties) {
                Object.keys(relationship.properties).forEach((fieldName) => {
                    if (relationship.properties[fieldName].unique) {
                        const isFieldActivated = _.get(relationship, `properties.${fieldName}.isActivated`, true);
                        result.push(
                            this.commentIfDeactivated(
                                this.getUniqeConstraint(relationship.name, fieldName),
                                isFieldActivated && isRelationshipActivated
                            )
                        );
                    }
                });
            }
        });

        return result;
    },

    getNodeKeyConstraint(collection, constraint) {
        let keys = [];
        if (constraint.compositeNodeKey) {
            keys = this.findFields(
                collection,
                constraint.compositeNodeKey.map((key) => key.keyId)
            );
            if (Array.isArray(keys) && keys.length) {
                const labelName = collection.collectionName;
                const varLabelName = collection.collectionName.toLowerCase();

                return this.commentIfDeactivated(
                    `CREATE CONSTRAINT ON (${screen(varLabelName)}:${screen(labelName)}) ASSERT (${keys
                        .map((key) => `${screen(varLabelName)}.${screen(key.name)}`)
                        .join(', ')}) IS NODE KEY`,
                    keys.every((key) => key.isActivated)
                );
            }
        }
    },

    getExistsConstraint(labelName, fieldName) {
        const varLabelName = labelName.toLowerCase();

        return `CREATE CONSTRAINT ON (${screen(varLabelName)}:${screen(labelName)}) ASSERT exists(${screen(
            varLabelName
        )}.${screen(fieldName)})`;
    },

    getUniqeConstraint(labelName, fieldName) {
        const varLabelName = labelName.toLowerCase();

        return `CREATE CONSTRAINT ON (${screen(varLabelName)}:${screen(labelName)}) ASSERT ${screen(
            varLabelName
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

    getIndexes(collections) {
        let result = [];
        collections.forEach((collection) => {
            if (collection.index) {
                collection.index.forEach((index) => {
                    if (index.key) {
                        const fields = this.findFields(
                            collection,
                            index.key.map((key) => key.keyId)
                        );
                        if (fields.length) {
                            const indexScript = this.getIndex(collection.collectionName, fields);
                            result.push(indexScript);
                        }
                    }
                });
            }
        });
        return result;
    },

    getIndex(collectionName, fields) {
        return this.commentIfDeactivated(
            `CREATE INDEX ON :${screen(collectionName)}(${fields.map((field) => screen(field.name)).join(', ')})`,
            fields.every((field) => field.isActivated)
        );
    },

    getObjectValueBySchema(data, fieldSchema) {
        if (fieldSchema && fieldSchema.type === 'spatial') {
            if (fieldSchema.mode === 'point') {
                return `point(${this.toCypherJson(data)})`;
            }
        }

        return `apoc.convert.toJson(${this.toCypherJson(data)})`;
    },

    getArrayValueBySchema(data, arraySchema) {
        return data.map((item, i) => {
            if (Object(item) === item && !Array.isArray(item)) {
                return this.getObjectValueBySchema(item, Array.isArray(arraySchema) ? arraySchema[i] : arraySchema);
            } else if (Array.isArray(item)) {
                return `[ ${this.getArrayValueBySchema(
                    item,
                    (Array.isArray(arraySchema) ? arraySchema[i] : arraySchema).items
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

const screen = (s) => `\`${s}\``;
