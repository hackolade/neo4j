const { forwardEngineeringHelper } = require('./forwardEngineeringHelper');

function generateContainerScript(data, logger, cb) {
	let { collections, relationships, jsonData } = data;
	const dbVersion = data.modelData[0]?.dbVersion;
	logger.clear();
	try {
		collections = collections.map(JSON.parse);
		relationships = relationships.map(JSON.parse);

		const createScript = forwardEngineeringHelper.generateCreateBatch(collections, relationships, jsonData, logger);
		const constraints = forwardEngineeringHelper.generateConstraints(dbVersion, collections, relationships);
		const indexes = forwardEngineeringHelper.getIndexes(dbVersion, collections, relationships);

		cb(null, forwardEngineeringHelper.getScript(createScript, constraints, indexes, dbVersion));
	} catch (e) {
		logger.log('error', { message: e.message, stack: e.stack }, 'Forward-Engineering Error');
		setTimeout(() => {
			cb({ message: e.message, stack: e.stack });
		}, 150);
	}
}

module.exports = { generateContainerScript };
