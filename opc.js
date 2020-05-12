
var WEBSOCKET_STATES = {
  0: 'connecting',
  1: 'open',
  2: 'closing',
  3: 'closed'
}

OPC = function (host, layoutFile, mainCanvas, overlayCanvas, stateHandler) {
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
    if (!unitPixels.length || !mainCanvas.width || !mainCanvas.height) {
      return;
    }
    let width = mainCanvas.width;
    let height = mainCanvas.height;
    let canvasRatio = width/height;
    let pixelWidth, pixelHeight, xoffset, yoffset, scale;
    if (canvasRatio < ratio) {
      pixelWidth = width;
      pixelHeight = width / ratio;
      xoffset = 0;
      yoffset = (height - pixelHeight) / 2.0;
      scale = ratio < 1.0 ? width / ratio : width;
    } else {
      pixelWidth = height * ratio;
      pixelHeight = height;
      xoffset = (width - pixelWidth) / 2.0;
      yoffset = 0;
      scale = ratio > 1.0 ? height * ratio : height;
    }
    pixels = unitPixels.map(coord => [
        Math.round(coord[0] * scale + xoffset),
        Math.round(coord[1] * scale + yoffset)]);
    let ctx = self.overlayCanvas.getContext('2d');
    self.overlayCanvas.width = width;
    self.overlayCanvas.height = height;
    ctx.clearRect(0, 0, self.overlayCanvas.width, self.overlayCanvas.height);
    for (let i in pixels) {
      ctx.fillStyle = 'white';
      ctx.fillRect(pixels[i][0], pixels[i][1], 1, 1);
      ctx.fillStyle = 'black';
      ctx.fillRect(pixels[i][0] + 1, pixels[i][1], 1, 1);
    }
  }

  this.send = function() {
    var packet = [];
    var data = new Uint8Array(mainCanvas.width * mainCanvas.height * 4);
    gl.readPixels(
      0, 0, mainCanvas.width, mainCanvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    for (let i in pixels) {
      let idx = (
          pixels[i][0] +
          (mainCanvas.height-1-pixels[i][1]) * mainCanvas.width) * 4;
      packet.push(data[idx], data[idx+1], data[idx+2]);
      /*let ctx = self.overlayCanvas.getContext('2d');
      ctx.fillStyle = `rgb(${data[idx]}, ${data[idx+1]}, ${data[idx+2]})`;
      ctx.beginPath();
      ctx.arc(pixels[i][0], pixels[i][1], 5, 0, Math.PI*2);
      ctx.fill();*/
    }
    if (self.using_websockify) {
      // gl_server expects the packet length, as is the OPC standard
      packet.unshift(0, 0, (packet.length >> 8) & 0xFF, packet.length & 0xFF);
    } else {
      // fcserver expects 0s because the TCP packet already defines length
      packet.unshift(0, 0, 0, 0);
    }
    _sendPacket(packet);
  }


  var _sendPacket = function(pkt) {
    if (self.ws.readyState == 1) {
      var packet = new Uint8Array(pkt);
      self.ws.send(packet.buffer);
    }
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
    self.stateHandler(self.getState());
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
  this.connect();

  // This will be an array of (x,y) coordinates in the range (0, 1)
  var unitPixels = [];
  // This will be based on canvas dimensions, which can change
  var pixels = [];
  // Width/height aspect ratio
  var ratio = null;
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
    // Now we know our final width-to-height ratio including padding
    ratio = (ranges[0] + padding) / (ranges[1] + padding);
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
  });
}
