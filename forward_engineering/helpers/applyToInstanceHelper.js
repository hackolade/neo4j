const neo4jHelper = require('../../reverse_engineering/neo4jHelper');

const applyToInstanceHelper = {
	async applyToInstance(connectionInfo, logger, sshService) {
		try {
			logger.log(
				'info',
				{
					message: 'Applying cypher script has been started',
				},
				'Neo4j script',
			);

			await neo4jHelper.connect(connectionInfo, () => Promise.resolve(), sshService);
			const instanceSupportMultiDb = await neo4jHelper.supportsMultiDb();
			const dbData = connectionInfo.containerData?.[0];
			const dbName = dbData?.code || dbData?.name || 'neo4j';

			const statements = connectionInfo.script
				.split(';')
				.map(statement => {
					const filteredStatement = statement
						.split('\n')
						.filter(s => {
							const trimmed = s.trim();
							return trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith(':');
						})
						.join('\n');
					return filteredStatement;
				})
				.filter(s => s.trim().length > 0);

			let completedStatementsCounter = 0;
			for (const statement of statements) {
				try {
					neo4jHelper.setTimeOut();
					await neo4jHelper.execute(statement, dbName, instanceSupportMultiDb);
					logger.progress({
						message: `Completed queries: ${++completedStatementsCounter} / ${statements.length}`,
					});
				} catch (err) {
					throw { ...err, statement, message: err.message };
				}
			}

			logger.log(
				'info',
				{
					message: 'Cypher script has been applied successfully!',
				},
				'Neo4j script',
			);
		} catch (err) {
			logger.log(
				'error',
				{
					error: { message: err.message, stack: err.stack },
					details: { ...err, message: err.message },
				},
				'Cypher script: query has been executed with error',
			);
			throw { ...err, type: 'simpleError', message: err.message };
		} finally {
			neo4jHelper.close(sshService);
		}
	},

	async testConnection(connectionInfo, sshService) {
		await neo4jHelper.connect(connectionInfo, () => Promise.resolve(), sshService);
		await neo4jHelper.close(sshService);
	},
};

module.exports = applyToInstanceHelper;
