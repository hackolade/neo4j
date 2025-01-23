const extractCollectionProperties = collection => {
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

	return properties;
};

module.exports = { extractCollectionProperties };
