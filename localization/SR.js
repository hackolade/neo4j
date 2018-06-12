
// Model Product
function Product(id, description) {
    this.getId = function() {
        return id;
    };
    this.getDescription = function() {
        return description;
    };	
}

// Model Cart
function Cart() {
    var items = [];

    this.addItem = function(item) {
        items.push(item);
    };
 
    this.getItems = function(item) {
        return items;
    };
}

(() => {
    let products = [
        new Product(1, 'MacBook Air'),
        new Product(2, 'iPhone 5s'),
        new Product(3, 'iPad mini')
    ],
    cart = new Cart();

    /**
     * Function for add product to the cart
     */
    const addToCart = (e) => {
		const productId = e.id;
		let product = products.find(p => p.id === productId);
		cart.addItem(product);

		let newItem = document.createElement("li");
		newItem.innerHTML = product.getDescription();
		newItem.setAttribute("id", product.getId());
		document.getElementById("#cart").appendChild(newItem);  
   };

   products.forEach(function(product) {
		let newItem = document.createElement("li");
		newItem.innerHTML = product.getDescription();
		newItem.setAttribute("id", product.getId());
		newItem.ondblclick = addToCart;
		document.getElementById("#products").appendChild(newItem);  
   });
})();