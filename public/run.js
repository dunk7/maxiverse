let objects = null;
let running = false;
let frame = 0;
let rafId; // Declare rafId for requestAnimationFrame

let state = {

	object0: {
		position: (0,0),
		size: 1,
		rotation: 0,
		alpha: 1,
		image: "blue circle"
		variables: {
			score: 0
		}
		current_node: 0

	}
};

running = true;
console.log("Game started");
rafId = requestAnimationFrame(update);

function update() {
	frame += 1;
	console.log(`Frame ${frame}:`, state, rafId);

	// Loop through objects in state
	  for (let key in state) {
	    if (state.hasOwnProperty(key)) {
	      let obj = state[key];
	      // Example: Update position (you can customize this logic)
	      obj.position[0] += 1; // Move object to the right by 1 unit per frame
	      console.log(`Updated ${key}: position = ${obj.position}`);
	    }
	  }
	if (running) {
		rafId = requestAnimationFrame(update);
	}
}