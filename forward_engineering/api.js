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

        let labels = this.createMap(collections, relationships)
            .reduce((batch, branchData) => {
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
                    parent = `(${screen(parentName).toLowerCase()})`;
                } else {
                    let parentData = '';
                    if (jsonData[branchData.parent.GUID]) {
                        parentData = ' ' + this.prepareData(jsonData[branchData.parent.GUID], branchData.parent);
                    }

                    parent = `(${screen(parentName).toLowerCase()}:${screen(parentName)}${parentData})`;
                    createdHash[parentName] = true;
                }

                if (branchData.relationship && branchData.child) {
                    relationshipName = branchData.relationship.name;
                    if (branchData.relationship && jsonData[branchData.relationship.GUID]) {
                        relationshipData =
                            ' ' + this.prepareData(jsonData[branchData.relationship.GUID], branchData.relationship);
                    }
                    relationship = `[:${screen(relationshipName)}${relationshipData}]`;

                    childName = branchData.child.collectionName;
                    if (createdHash[childName]) {
                        child = `(${screen(childName).toLowerCase()})`;
                    } else {
                        if (branchData.child && jsonData[branchData.child.GUID]) {
                            childData = ' ' + this.prepareData(jsonData[branchData.child.GUID], branchData.child);
                        }
                        child = `(${screen(childName).toLowerCase()}:${screen(childName)}${childData})`;
                        createdHash[childName] = true;
                    }

                    batch.push(
                        this.commentIfDeactivated(
                            `${parent}-${relationship}->${child}`,
                            branchData.child.isActivated && branchData.parent.isActivated
                        )
                    );

                    if (branchData.bidirectional) {
                        batch.push(
                            this.commentIfDeactivated(
                                `(${screen(childName).toLowerCase()})-${relationship}->(${screen(
                                    parentName
                                ).toLowerCase()})`,
                                branchData.child.isActivated && branchData.parent.isActivated
                            )
                        );
                    }
                } else {
                    batch.push(this.commentIfDeactivated(parent, branchData.parent.isActivated));
                }

                return batch;
            }, [])
            .join(',\n');

        let script = `CREATE ${labels}`;

        if (Object.keys(createdHash).length) {
            script += ` RETURN ${Object.keys(createdHash).map(screen).join(',').toLowerCase()}`;
        }

        return script;
    },

    prepareData(serializedData, schema) {
        const data = JSON.parse(serializedData);
        return (
            '{ ' +
            Object.keys(data)
                .reduce((result, field) => {
                    if (Object(data[field]) === data[field] && !Array.isArray(data[field])) {
                        result.push(
                            `${screen(field)}: ${this.getObjectValueBySchema(data[field], schema.properties[field])}`
                        );
                    } else if (Array.isArray(data[field])) {
                        result.push(
                            `${screen(field)}: [ ${this.getArrayValueBySchema(
                                data[field],
                                schema.properties[field].items
                            ).join(', ')} ]`
                        );
                    } else {
                        result.push(`${screen(field)}: ${JSON.stringify(data[field])}`);
                    }

                    return result;
                }, [])
                .join(', ') +
            ' }'
        );
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
            if (Array.isArray(relationship.required)) {
                relationship.required.forEach((fieldName) => {
                    if (fieldName) {
                        const isFieldActivated = _.get(relationship, `properties.${fieldName}.isActivated`, true);
                        result.push(
                            this.commentIfDeactivated(
                                this.getExistsConstraint(relationship.name, fieldName),
                                isFieldActivated
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
                                isFieldActivated
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

        return statement;
    },
};

const screen = (s) => `\`${s}\``;
