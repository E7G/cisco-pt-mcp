// User-callable functions exposed by the cisco-pt-mcp bridge.
// Each returns { success: bool, ... } and is invoked via $se('runCode', 'return <fn>(<args>);').

function fail(prefix, err) {
  var msg = (err && (err.message || String(err))) || "unknown error";
  return { success: false, error: prefix ? prefix + ": " + msg : msg };
}

addDevice = function (deviceName, deviceModel, x, y) {
  try {
    var deviceType = allDeviceTypes[deviceModel];

    if (deviceType === undefined) {
      return {
        success: false,
        error: `Unknown device model: ${deviceModel}`,
      };
    }

    var originalDeviceName = ipc
      .appWindow()
      .getActiveWorkspace()
      .getLogicalWorkspace()
      .addDevice(deviceType, deviceModel, x, y);

    if (!originalDeviceName) {
      return {
        success: false,
        error: `Failed to add device ${deviceName} (${deviceModel})`,
      };
    }

    var device = ipc.network().getDevice(originalDeviceName);
    device.setName(deviceName);

    if (deviceType <= 1 || deviceType == 16) {
      device.skipBoot();
    }

    return {
      success: true,
      message: `Device ${deviceName} added successfully`,
    };
  } catch (error) {
    return fail("Error adding device", error);
  }
};

addModule = function (deviceName, slot, model) {
  try {
    var device = ipc.network().getDevice(deviceName);

    if (!device) {
      return {
        success: false,
        error: `Device ${deviceName} not found`,
      };
    }

    var moduleType = allModuleTypes[model];

    if (moduleType === undefined) {
      return {
        success: false,
        error: `Unknown module model: ${model}`,
      };
    }

    var powerState = device.getPower();
    device.setPower(false);

    var result = device.addModule(slot, moduleType, model);

    if (powerState) {
      device.setPower(true);
      device.skipBoot();
    }

    if (result != true) {
      return {
        success: false,
        error: `Failed to add module ${model} to slot ${slot} on ${deviceName}`,
      };
    }

    return {
      success: true,
      message: `Module ${model} added to ${deviceName} slot ${slot}`,
    };
  } catch (error) {
    return fail("Error adding module", error);
  }
};

addLink = function (
  device1Name,
  device1Interface,
  device2Name,
  device2Interface,
  linkType
) {
  try {
    var linkTypeValue = allLinkTypes[linkType];

    if (linkTypeValue === undefined) {
      return {
        success: false,
        error: `Unknown link type: ${linkType}`,
      };
    }

    var result = ipc
      .appWindow()
      .getActiveWorkspace()
      .getLogicalWorkspace()
      .createLink(
        device1Name,
        device1Interface,
        device2Name,
        device2Interface,
        linkTypeValue
      );

    if (result != true) {
      return {
        success: false,
        error: `Failed to create link between ${device1Name}:${device1Interface} and ${device2Name}:${device2Interface}`,
      };
    }

    return {
      success: true,
      message: `Link created between ${device1Name} and ${device2Name}`,
    };
  } catch (error) {
    return fail("Error creating link", error);
  }
};

configurePcIp = function (
  deviceName,
  dhcpEnabled,
  ipaddress,
  subnetMask,
  defaultGateway,
  dnsServer
) {
  try {
    var device = ipc.network().getDevice(deviceName);

    if (!device) {
      return {
        success: false,
        error: `Device ${deviceName} not found`,
      };
    }

    var port = device.getPort("FastEthernet0");

    if (!port) {
      return {
        success: false,
        error: `FastEthernet0 port not found on ${deviceName}`,
      };
    }

    if (dhcpEnabled !== undefined && dhcpEnabled !== null) {
      device.setDhcpFlag(dhcpEnabled);
    }
    if (ipaddress && subnetMask) port.setIpSubnetMask(ipaddress, subnetMask);
    if (defaultGateway) port.setDefaultGateway(defaultGateway);
    if (dnsServer) port.setDnsServerIp(dnsServer);

    return {
      success: true,
      message: `IP configuration applied to ${deviceName}`,
    };
  } catch (error) {
    return fail("Error configuring PC IP", error);
  }
};

configureIosDevice = function (deviceName, commands) {
  try {
    var device = ipc.network().getDevice(deviceName);

    if (!device) {
      return {
        success: false,
        error: `Device ${deviceName} not found`,
      };
    }

    device.skipBoot();
    var commandsArray = commands.split("\n");
    var commandResults = [];
    var failed = [];

    function parseCommandStatus(result) {
      // PT pair<CommandStatus, string> can be exposed differently by runtime.
      if (result === undefined || result === null) {
        return { status: 0, message: "" };
      }
      if (Array.isArray(result)) {
        var stA = Number(result[0]);
        return { status: isNaN(stA) ? 0 : stA, message: String(result[1] || "") };
      }
      if (typeof result === "object") {
        if ("first" in result || "second" in result) {
          var stF = Number(result.first);
          return { status: isNaN(stF) ? 0 : stF, message: String(result.second || "") };
        }
        if ("status" in result || "message" in result) {
          var stS = Number(result.status);
          return { status: isNaN(stS) ? 0 : stS, message: String(result.message || "") };
        }
      }
      return { status: 0, message: String(result) };
    }

    // Ensure we are in config context before applying multiline commands.
    parseCommandStatus(device.enterCommand("enable", "user"));
    parseCommandStatus(device.enterCommand("configure terminal", "enable"));

    for (var c = 0; c < commandsArray.length; c++) {
      var command = commandsArray[c];
      if (command.trim()) {
        var raw = device.enterCommand(command, "");
        var parsed = parseCommandStatus(raw);
        commandResults.push({
          command: command,
          status: parsed.status,
          message: parsed.message,
        });
        if (parsed.status !== 0) {
          failed.push({
            command: command,
            status: parsed.status,
            message: parsed.message,
          });
        }
      }
    }

    parseCommandStatus(device.enterCommand("end", ""));
    parseCommandStatus(device.enterCommand("write memory", "enable"));

    if (failed.length > 0) {
      var firstFail = failed[0];
      return {
        success: false,
        error:
          "IOS command failed on " + deviceName +
          " (status=" + firstFail.status + "): " + firstFail.command +
          (firstFail.message ? " -> " + firstFail.message : ""),
        failedCommands: failed,
        commandResults: commandResults,
      };
    }

    return {
      success: true,
      message: `Configuration applied to ${deviceName} (${commandResults.length} commands)`,
      commandResults: commandResults,
    };
  } catch (error) {
    return fail("Error configuring IOS device", error);
  }
};

getNetwork = function () {
  try {
    var deviceCount = ipc.network().getDeviceCount();
    var devices = [];
    var connections = [];
    var portOwnerByRef = [];
    var portOwnerByName = {};
    var seenConnectionSet = {};

    function makeEndpointKey(deviceName, portName) {
      return deviceName + "::" + portName;
    }

    function rememberPortOwner(portObj, deviceName, portName) {
      portOwnerByRef.push({
        port: portObj,
        deviceName: deviceName,
        portName: portName,
      });
    }

    function resolveOwnerByPortRef(portObj) {
      for (var idx = 0; idx < portOwnerByRef.length; idx++) {
        if (portOwnerByRef[idx].port === portObj) {
          return portOwnerByRef[idx].deviceName;
        }
      }
      return null;
    }

    // Pass 1: enumerate devices and set in_use via each port's attached link.
    for (var i = 0; i < deviceCount; i++) {
      var device = ipc.network().getDeviceAt(i);
      var deviceName = device.getName();
      var interfaces = [];
      var portCount = device.getPortCount();

      for (var j = 0; j < portCount; j++) {
        var port = device.getPortAt(j);
        if (!port) continue;

        var pname = port.getName();
        var link = null;
        var hasLink = false;

        rememberPortOwner(port, deviceName, pname);
        if (!portOwnerByName[pname]) portOwnerByName[pname] = [];
        portOwnerByName[pname].push(deviceName);

        try {
          link = port.getLink();
          hasLink = !!link;
        } catch (_) {
          hasLink = false;
        }

        interfaces.push({ name: pname, in_use: hasLink });
      }

      devices.push({
        name: deviceName,
        model: device.getModel(),
        type: device.getType(),
        interfaces: interfaces,
      });
    }

    // Pass 2: build connections from the network link table.
    var linkCount = ipc.network().getLinkCount();
    for (var li = 0; li < linkCount; li++) {
      var netLink = ipc.network().getLinkAt(li);
      if (!netLink) continue;

      var p1 = null;
      var p2 = null;
      try {
        p1 = netLink.getPort1();
        p2 = netLink.getPort2();
      } catch (_) {
        p1 = null;
        p2 = null;
      }
      if (!p1 || !p2) continue;

      var p1Name = p1.getName();
      var p2Name = p2.getName();
      var d1Name = null;
      var d2Name = null;

      try {
        var d1 = p1.getOwnerDevice();
        if (d1) d1Name = d1.getName();
      } catch (_) {}
      try {
        var d2 = p2.getOwnerDevice();
        if (d2) d2Name = d2.getName();
      } catch (_) {}

      // Fallback 1: object identity mapping from enumerated device ports.
      if (!d1Name) d1Name = resolveOwnerByPortRef(p1);
      if (!d2Name) d2Name = resolveOwnerByPortRef(p2);

      // Fallback 2: port-name mapping only when globally unique.
      if (!d1Name) {
        var owners1 = portOwnerByName[p1Name];
        if (owners1 && owners1.length === 1) d1Name = owners1[0];
      }
      if (!d2Name) {
        var owners2 = portOwnerByName[p2Name];
        if (owners2 && owners2.length === 1) d2Name = owners2[0];
      }

      if (!d1Name || !d2Name) continue;

      var endpointA = makeEndpointKey(d1Name, p1Name);
      var endpointB = makeEndpointKey(d2Name, p2Name);
      var pairKey = endpointA < endpointB
        ? endpointA + "<->" + endpointB
        : endpointB + "<->" + endpointA;
      if (seenConnectionSet[pairKey] === true) continue;
      seenConnectionSet[pairKey] = true;

      connections.push({
        from: d1Name,
        fromInterface: p1Name,
        to: d2Name,
        toInterface: p2Name,
        type: typeof netLink.getConnectionType === "function"
          ? netLink.getConnectionType()
          : "",
      });
    }

    return {
      success: true,
      result: {
        deviceCount: devices.length,
        connectionCount: connections.length,
        devices: devices,
        connections: connections,
      },
    };
  } catch (error) {
    return fail("", error);
  }
};

getDeviceInfo = function (deviceName) {
  try {
    var net = getNetwork();
    if (!net || !net.success) {
      return net || { success: false, error: "getNetwork failed" };
    }
    var devices = net.result.devices;
    var connections = net.result.connections;
    for (var i = 0; i < devices.length; i++) {
      if (devices[i].name === deviceName) {
        var related = [];
        for (var j = 0; j < connections.length; j++) {
          var c = connections[j];
          if (c.from === deviceName || c.to === deviceName) related.push(c);
        }
        return {
          success: true,
          result: {
            device: devices[i],
            connections: related,
          },
        };
      }
    }
    return {
      success: false,
      error: `Device ${deviceName} not found`,
    };
  } catch (error) {
    return fail("Error getting device info", error);
  }
};

removeDevice = function (deviceNames) {
  try {
    var devicesToRemove = [];
    if (typeof deviceNames === "string") {
      devicesToRemove = [deviceNames];
    } else if (Array.isArray(deviceNames)) {
      devicesToRemove = deviceNames;
    } else {
      return {
        success: false,
        error:
          "Invalid input: provide a device name string or array of device names",
      };
    }

    var workspace = ipc.appWindow().getActiveWorkspace().getLogicalWorkspace();
    var results = [];
    var successCount = 0;
    var failCount = 0;

    for (var i = 0; i < devicesToRemove.length; i++) {
      var deviceName = devicesToRemove[i];
      var device = ipc.network().getDevice(deviceName);

      if (!device) {
        results.push({
          device: deviceName,
          success: false,
          error: "Device not found",
        });
        failCount++;
      } else {
        var result = workspace.removeDevice(deviceName);

        if (result === true) {
          results.push({
            device: deviceName,
            success: true,
            message: "Removed successfully",
          });
          successCount++;
        } else {
          results.push({
            device: deviceName,
            success: false,
            error: "Failed to remove",
          });
          failCount++;
        }
      }
    }

    return {
      success: failCount === 0,
      totalDevices: devicesToRemove.length,
      successCount: successCount,
      failCount: failCount,
      results: results,
    };
  } catch (error) {
    return fail("Error removing devices", error);
  }
};

setSimulationMode = function (toSimMode) {
  try {
    var sim = ipc.simulation();
    var current = sim.isSimulationMode();
    if (current === toSimMode) {
      return {
        success: true,
        message: "Already in " + (toSimMode ? "simulation" : "realtime") + " mode",
        mode: toSimMode ? "simulation" : "realtime",
      };
    }
    sim.setSimulationMode(toSimMode);
    return {
      success: true,
      message: "Switched to " + (toSimMode ? "simulation" : "realtime") + " mode",
      mode: toSimMode ? "simulation" : "realtime",
    };
  } catch (error) {
    return fail("Error setting simulation mode", error);
  }
};

getSimulationStatus = function () {
  try {
    var sim = ipc.simulation();
    var isSimMode = sim.isSimulationMode();
    var result = { mode: isSimMode ? "simulation" : "realtime" };
    if (isSimMode) {
      result.currentTime = sim.getCurrentSimTime();
      result.frameCount = sim.getFrameInstanceCount();
      result.currentFrameIndex = sim.getCurrentFrameInstanceIndex();
    }
    return { success: true, result: result };
  } catch (error) {
    return fail("Error getting simulation status", error);
  }
};

stepSimulation = function (direction, steps) {
  try {
    var sim = ipc.simulation();
    if (!sim.isSimulationMode()) {
      return {
        success: false,
        error: "Not in simulation mode. Call setSimulationMode(true) first.",
      };
    }
    if (direction === "reset") {
      sim.resetSimulation();
      return { success: true, message: "Simulation reset" };
    }
    var n = steps && steps >= 1 ? Math.min(steps, 100) : 1;
    for (var i = 0; i < n; i++) {
      if (direction === "forward") {
        sim.forward();
      } else if (direction === "backward") {
        sim.backward();
      } else {
        return { success: false, error: "Unknown direction: " + direction };
      }
    }
    return {
      success: true,
      message: direction + " " + n + " step(s)",
      currentTime: sim.getCurrentSimTime(),
      frameCount: sim.getFrameInstanceCount(),
    };
  } catch (error) {
    return fail("Error stepping simulation", error);
  }
};

var PDU_TRAFFIC_TYPES = {
  ICMP: 0,
  TCP: 1,
  UDP: 2,
  HTTP: 17,
  HTTPS: 18,
  DNS: 19,
};

sendPdu = function (sourceDevice, destinationDevice) {
  try {
    var sim = ipc.simulation();
    var modeEnabled = false;
    if (!sim.isSimulationMode()) {
      sim.setSimulationMode(true);
      modeEnabled = true;
    }
    if (!ipc.network().getDevice(sourceDevice)) {
      return { success: false, error: "Source device not found: " + sourceDevice };
    }
    if (!ipc.network().getDevice(destinationDevice)) {
      return { success: false, error: "Destination device not found: " + destinationDevice };
    }
    var beforeCount = sim.getFrameInstanceCount();
    var errCode = ipc.appWindow().getUserCreatedPDU().addSimplePdu(sourceDevice, destinationDevice);
    // ADD_PDU_ERROR: 0 / falsy = success
    var errStr = String(errCode);
    if (errCode && errStr !== "0") {
      return { success: false, error: "PT rejected PDU (ADD_PDU_ERROR=" + errStr + ")" };
    }
    var afterCount = sim.getFrameInstanceCount();
    var frameDelta = afterCount - beforeCount;
    // In healthy sessions addSimplePdu should immediately add frame instances.
    // If not, surface it explicitly so callers do not trust a false-positive success.
    if (frameDelta <= 0) {
      return {
        success: false,
        error:
          "PDU enqueue returned success, but simulation frame count did not increase. " +
          "PT session may be unhealthy.",
        sourceDevice: sourceDevice,
        destinationDevice: destinationDevice,
        frameCountBefore: beforeCount,
        frameCountAfter: afterCount,
      };
    }
    return {
      success: true,
      message: "ICMP PDU added from " + sourceDevice + " to " + destinationDevice,
      simulationModeEnabled: modeEnabled,
      frameCountBefore: beforeCount,
      frameCountAfter: afterCount,
      frameDelta: frameDelta,
    };
  } catch (error) {
    return fail("Error sending PDU", error);
  }
};

renameDevice = function (deviceName, newName) {
  try {
    var device = ipc.network().getDevice(deviceName);
    if (!device) {
      return { success: false, error: "Device not found: " + deviceName };
    }
    device.setName(newName);
    return { success: true, message: "Renamed " + deviceName + " to " + newName };
  } catch (error) {
    return fail("Error renaming device", error);
  }
};

moveDevice = function (deviceName, x, y) {
  try {
    var device = ipc.network().getDevice(deviceName);
    if (!device) {
      return { success: false, error: "Device not found: " + deviceName };
    }
    device.moveToLocation(x, y);
    return {
      success: true,
      message: "Moved " + deviceName + " to (" + x + ", " + y + ")",
    };
  } catch (error) {
    return fail("Error moving device", error);
  }
};

// Maps both numeric and C++ enum-string forms of eTrafficType to readable names.
// PT's JS host may expose the enum as "0" or as "eTrafficType_Icmp" — handle both.
var TRAFFIC_TYPE_NAMES = {
  "0": "ICMP",  "eTrafficType_Icmp": "ICMP",
  "1": "TCP",   "eTrafficType_Tcp": "TCP",
  "2": "UDP",   "eTrafficType_Udp": "UDP",
  "3": "RIPv1", "eTrafficType_RipV1": "RIPv1",
  "4": "RIPv2", "eTrafficType_RipV2": "RIPv2",
  "5": "ARP",   "eTrafficType_Arp": "ARP",
  "6": "CDP",   "eTrafficType_Cdp": "CDP",
  "7": "DHCP",  "eTrafficType_Dhcp": "DHCP",
  "11": "STP",  "eTrafficType_Stp": "STP",
  "12": "OSPF", "eTrafficType_Ospf": "OSPF",
  "13": "DTP",  "eTrafficType_Dtp": "DTP",
  "17": "HTTP", "eTrafficType_Http": "HTTP",
  "18": "HTTPS","eTrafficType_Https": "HTTPS",
  "19": "DNS",  "eTrafficType_Dns": "DNS",
  "36": "BGP",  "eTrafficType_Bgp": "BGP",
  "1000": "Custom", "eTrafficType_Custom": "Custom",
};

getPduResults = function (types, sinceIndex, limit, sourceDevice, destinationDevice, statuses) {
  try {
    var sim = ipc.simulation();
    if (!sim.isSimulationMode()) {
      return { success: false, error: "Not in simulation mode. Call setSimulationMode(true) first." };
    }

    var typeFilter = null;
    if (Array.isArray(types) && types.length > 0) {
      typeFilter = {};
      for (var t = 0; t < types.length; t++) typeFilter[types[t].toUpperCase()] = true;
    }

    var statusFilter = null;
    if (Array.isArray(statuses) && statuses.length > 0) {
      statusFilter = {};
      for (var s = 0; s < statuses.length; s++) {
        statusFilter[String(statuses[s]).toLowerCase()] = true;
      }
    }
    var srcFilter = sourceDevice ? String(sourceDevice).toLowerCase() : null;
    var dstFilter = destinationDevice ? String(destinationDevice).toLowerCase() : null;
    var startIndex = Number(sinceIndex);
    if (isNaN(startIndex) || startIndex < 0) startIndex = 0;
    var cap = Number(limit);
    if (isNaN(cap) || cap <= 0) cap = 500;

    var total = sim.getFrameInstanceCount();
    var frames = [];
    var acceptedCount = 0;
    var droppedCount = 0;
    var newestIndex = -1;
    for (var i = startIndex; i < total; i++) {
      var fi = sim.getFrameInstanceAt(i);
      if (!fi) continue;

      var rawType = String(fi.getUserTrafficType());
      var typeName = TRAFFIC_TYPE_NAMES[rawType] || rawType;

      if (typeFilter && !typeFilter[typeName.toUpperCase()]) continue;

      var status = "unknown";
      if (fi.isFrameAccepted())          status = "accepted";
      else if (fi.isFrameDropped())      status = "dropped";
      else if (fi.isFrameNotForwarded()) status = "not_forwarded";
      else if (fi.isFrameUnexpected())   status = "unexpected";
      else if (fi.isFrameCollidedOnLink() || fi.isFrameCollidedAtDevice()) status = "collision";
      else if (fi.isFrameBuffered())     status = "buffered";
      else if (fi.isFrameOnTransit())    status = "in_transit";
      else if (fi.isFrameSent())         status = "sent";

      var src = fi.getSourceString();
      var dst = fi.getDestinationString();
      var srcText = String(src || "").toLowerCase();
      var dstText = String(dst || "").toLowerCase();
      if (srcFilter && srcText.indexOf(srcFilter) === -1) continue;
      if (dstFilter && dstText.indexOf(dstFilter) === -1) continue;
      if (statusFilter && !statusFilter[status]) continue;

      if (status === "accepted") acceptedCount++;
      if (status === "dropped") droppedCount++;
      newestIndex = i;
      frames.push({
        index: i,
        source: src,
        destination: dst,
        trafficType: typeName,
        status: status,
      });
      if (frames.length >= cap) break;
    }
    return {
      success: true,
      result: {
        totalFrames: total,
        shown: frames.length,
        startIndex: startIndex,
        newestIndex: newestIndex,
        acceptedCount: acceptedCount,
        droppedCount: droppedCount,
        frames: frames,
      },
    };
  } catch (error) {
    return fail("Error getting PDU results", error);
  }
};

getCommandLog = function (deviceName, limit) {
  try {
    var log = ipc.commandLog();
    var total = log.getEntryCount();
    var cap = limit && limit > 0 ? Math.min(limit, 500) : 50;
    var entries = [];

    for (var i = total - 1; i >= 0 && entries.length < cap; i--) {
      var entry = log.getEntryAt(i);
      if (!entry) continue;
      var dev = entry.getDeviceName();
      if (deviceName && dev !== deviceName) continue;
      entries.push({
        timestamp: entry.getTimeToString(),
        device: dev,
        prompt: entry.getPrompt(),
        command: entry.getCommand(),
        resolvedCommand: entry.getResolvedCommand(),
      });
    }

    return {
      success: true,
      result: { totalEntries: total, returned: entries.length, entries: entries },
    };
  } catch (error) {
    return fail("Error getting command log", error);
  }
};

setPower = function (deviceName, power) {
  try {
    var device = ipc.network().getDevice(deviceName);
    if (!device) {
      return { success: false, error: "Device not found: " + deviceName };
    }
    device.setPower(power);
    return {
      success: true,
      message: deviceName + " powered " + (power ? "on" : "off"),
    };
  } catch (error) {
    return fail("Error setting device power", error);
  }
};

removeLink = function (links) {
  try {
    var linksToRemove = [];

    if (typeof links === "object" && links !== null && !Array.isArray(links)) {
      linksToRemove = [links];
    } else if (Array.isArray(links)) {
      linksToRemove = links;
    } else {
      return {
        success: false,
        error:
          "Invalid input: provide link object {device, port} or array of link objects",
      };
    }

    var workspace = ipc.appWindow().getActiveWorkspace().getLogicalWorkspace();
    var results = [];
    var successCount = 0;
    var failCount = 0;

    for (var i = 0; i < linksToRemove.length; i++) {
      var link = linksToRemove[i];
      var deviceName = link.device || link.deviceName;
      var portName = link.port || link.portName;

      if (!deviceName || !portName) {
        results.push({
          device: deviceName,
          port: portName,
          success: false,
          error: "Missing device or port",
        });
        failCount++;
        continue;
      }

      var device = ipc.network().getDevice(deviceName);
      if (!device) {
        results.push({
          device: deviceName,
          port: portName,
          success: false,
          error: "Device not found",
        });
        failCount++;
        continue;
      }

      var result = workspace.deleteLink(deviceName, portName);

      if (result === true) {
        results.push({
          device: deviceName,
          port: portName,
          success: true,
          message: "Link removed successfully",
        });
        successCount++;
      } else {
        results.push({
          device: deviceName,
          port: portName,
          success: false,
          error: "Failed to remove link",
        });
        failCount++;
      }
    }

    return {
      success: failCount === 0,
      totalLinks: linksToRemove.length,
      successCount: successCount,
      failCount: failCount,
      results: results,
    };
  } catch (error) {
    return fail("Error removing links", error);
  }
};
