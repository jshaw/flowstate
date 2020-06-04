
var WEBSOCKET_STATES = {
  0: 'connecting',
  1: 'open',
  2: 'closing',
  3: 'closed'
}

OPC = function(
    host, layoutFile, mainCanvas, overlayCanvas, stateHandler) {
  var self = this;

  // https://codepen.io/KryptoniteDove/post/load-json-file-locally-using-pure-javascript
  function loadJSON(file, callback) {
    var xobj = new XMLHttpRequest();
      xobj.overrideMimeType("application/json");
    xobj.open('GET', file, true);
    xobj.onreadystatechange = function () {
      if (xobj.readyState == 4 && xobj.status == "200") {
        // Required use of an anonymous callback as .open will NOT return a value but simply returns undefined in asynchronous mode
        callback(xobj.responseText);
      }
    };
    xobj.send(null);
  }

  this.resize = function() {
    width = mainCanvas.width;
    height = mainCanvas.height;
    if (!unitPixels.length || !width || !height) {
      return;
    }
    let canvasRatio = width/height;
    let pixelWidth, pixelHeight, xoffset, yoffset, scale;
    if (canvasRatio < self.aspectRatio) {
      pixelWidth = width;
      pixelHeight = width / self.aspectRatio;
      xoffset = 0;
      yoffset = (height - pixelHeight) / 2.0;
      scale = self.aspectRatio < 1.0 ? width / self.aspectRatio : width;
    } else {
      pixelWidth = height * self.aspectRatio;
      pixelHeight = height;
      xoffset = (width - pixelWidth) / 2.0;
      yoffset = 0;
      scale = self.aspectRatio > 1.0 ? height * self.aspectRatio : height;
    }
    pixels = unitPixels.map(coord => (
        Math.round(coord[0] * scale + xoffset) +
        (height-1-Math.round(coord[1] * scale + yoffset)) * width) * 4);

    // These vars will be used in send(); only initialize them once
    len = pixels.length;
    packet = new Uint8Array(len * 3 + 4);
    data = new Uint8Array(width * height * 4);
    packet[0] = 0;
    packet[1] = 0;
    packet[2] = self.using_websockify ? (len >> 8) & 0xFF : 0;
    packet[3] = self.using_websockify ? len & 0xFF : 0;

    let ctx = self.overlayCanvas.getContext('2d');
    self.overlayCanvas.width = width;
    self.overlayCanvas.height = height;
    ctx.clearRect(0, 0, self.overlayCanvas.width, self.overlayCanvas.height);
    unitPixels.forEach(coord => {
      const x = Math.round(coord[0] * scale + xoffset);
      const y = Math.round(coord[1] * scale + yoffset);
      ctx.fillStyle = 'white';
      ctx.fillRect(x, y, 1, 1);
      ctx.fillStyle = 'black';
      ctx.fillRect(x+1, y, 1, 1);
    });
  }

  this.send = function() {
    if (!self.ws || self.ws.readyState != 1 || !len) {
      return;
    }
    gl.readPixels(
      0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    pixels.forEach((idx, i) => {
      packet[4 + i*3] = data[idx];
      packet[5 + i*3] = data[idx+1];
      packet[6 + i*3] = data[idx+2];
    });
    self.ws.send(packet.buffer);
  }

  var _baseConnect = function() {
    self.ws = new WebSocket(
      self.host || "ws://localhost:7890",
      self.using_websockify ? ['binary', 'base64'] : ['fcserver']);
    self.ws.onerror = _onStateChange;
    self.ws.onopen = _onStateChange;
    self.ws.onclose = _onStateChange;
  }

  var _onStateChange = function(evt) {
    if (evt.type == 'error' && self.connecting_without_websockify) {
      // Connecting without websockify didn't work; try again with websockify.
      // This will fall back to setups using websockify as a proxy to a true
      // openpixelcontrol server.
      self.using_websockify = true;
      _baseConnect();
    }
    self.connecting_without_websockify = false;
    self.stateHandler(self.getState(), self.aspectRatio);
  }

  this.connect = function() {
    // First, try without using_websockify, as if we're talking to a real
    // FadeCandy board.
    self.using_websockify = false;
    self.connecting_without_websockify = true;
    _baseConnect();
  }
  this.close = function() {
    self.ws.close();
  }
  this.toggleConnection = function() {
    if (self.ws.readyState == 1) {
      self.close();
    } else {
      self.connect();
    }
  }

  this.getState = function() {
    return WEBSOCKET_STATES[self.ws.readyState];
  }

  // http://stackoverflow.com/questions/4812686/closing-websocket-correctly-html5-javascript
  window.onbeforeunload = function() {
    self.ws.onclose = function () {}; // disable onclose handler first
    self.ws.close()
  };

  // ACTUAL CONSTRUCTOR STUFF
  this.host = host;
  this.layoutFile = layoutFile;
  this.mainCanvas = mainCanvas;
  this.overlayCanvas = overlayCanvas;
  this.stateHandler = stateHandler;

  // This will be an array of (x,y) coordinates in the range (0, 1)
  var unitPixels = [];
  // This will be based on canvas dimensions, which can change
  var pixels = [];
  // These are set in resize() so they don't have to be changed on every send()
  var width, height, len = 0, packet, data;
  const dims = [0, 1, 2];
  loadJSON(self.layoutFile, function(response) {
    // Load layout file JSON
    var layout = JSON.parse(response);
    // Break out into an array of values per (x,y,z) dimension
    var byDim = dims.map(dim => layout.map(obj => obj['point'][dim]));
    // Min/max of each dimension
    var mins = byDim.map(values => Math.min(...values));
    var maxs = byDim.map(values => Math.max(...values));
    // Total range of each dimension
    var ranges = dims.map(dim => maxs[dim] - mins[dim]);
    // Toss the smallest dimension since we're 2D
    var minDim = ranges.indexOf(Math.min(...ranges));
    [byDim, mins, maxs, ranges].forEach(a => {
      a.splice(minDim, 1);
    });
    // Estimate pixel count in one dimension, assuming even distribution
    var xCount = Math.sqrt(layout.length * ranges[0] / ranges[1]);
    // Use that to determine padding
    var padding = ranges[0] / xCount;
    // Now we know our final width-to-height aspect ratio including padding
    self.aspectRatio = (ranges[0] + padding) / (ranges[1] + padding);
    // Now find large dimension
    var maxDim = ranges.indexOf(Math.max(...ranges));
    // Plan to scale everything to range (0, 1) while leaving padding
    var scale = 1.0 / (ranges[maxDim] + padding);
    // And build final unitPixels array
    unitPixels = byDim[0].map((v, i) => [
        (v           - mins[0] + padding/2.0) * scale,
        (byDim[1][i] - mins[1] + padding/2.0) * scale
    ]);
    self.resize();
    self.connect();
  });
}
