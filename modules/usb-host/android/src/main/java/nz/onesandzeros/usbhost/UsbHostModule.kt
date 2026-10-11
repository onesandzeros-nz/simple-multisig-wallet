package nz.onesandzeros.usbhost

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.hardware.usb.UsbRequest
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

private const val TAG = "UsbHost"
private const val ACTION_USB_PERMISSION = "nz.onesandzeros.usbhost.USB_PERMISSION"

private const val EVENT_PACKET = "onPacket"
private const val EVENT_CLOSED = "onClosed"
private const val EVENT_DEVICES_CHANGED = "onDevicesChanged"

/** A packet is 64 bytes and goes out at once; this only bounds a device that has stopped listening. */
private const val WRITE_TIMEOUT_MS = 5000

internal class DeviceNotFoundException :
  CodedException("That device is no longer plugged in.", null)

internal class NoPermissionException :
  CodedException("This app has not been allowed to use that USB device.", null)

internal class NoEndpointsException :
  CodedException("That USB device does not have the interface a signing device should.", null)

internal class OpenFailedException :
  CodedException("Could not open the USB device. Unplug it, plug it back in and try again.", null)

internal class ClaimFailedException :
  CodedException("Another app is using the USB device. Close it and try again.", null)

internal class SessionClosedException :
  CodedException("The USB device was unplugged.", null)

internal class WriteFailedException :
  CodedException("The USB device stopped responding.", null)

/**
 * Raw packets to and from a USB device, for hardware wallets.
 *
 * Deliberately small: it lists what is plugged in, asks Android for permission,
 * and moves packets over one interface's interrupt endpoints. What the packets
 * mean — framing, encryption, the wallets' own protocols — is all in
 * TypeScript, where it is tested.
 *
 * Packets from the device arrive as events rather than as the result of a
 * read call. Expo runs every AsyncFunction on one shared thread, so a read
 * that waited minutes for someone to press a button on their device would
 * hold up the write and the close queued behind it.
 */
class UsbHostModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val usbManager: UsbManager
    get() = context.getSystemService(Context.USB_SERVICE) as UsbManager

  private val sessions = ConcurrentHashMap<Int, Session>()
  private val nextHandle = AtomicInteger(1)
  private val waitingForPermission = HashMap<String, MutableList<Promise>>()
  private var receiver: BroadcastReceiver? = null

  override fun definition() = ModuleDefinition {
    Name("UsbHost")

    Events(EVENT_PACKET, EVENT_CLOSED, EVENT_DEVICES_CHANGED)

    Constant("isSupported") {
      appContext.reactContext?.packageManager?.hasSystemFeature(PackageManager.FEATURE_USB_HOST) ?: false
    }

    Function("listDevices") {
      usbManager.deviceList.values.map { describe(it) }
    }

    AsyncFunction("requestPermission") { deviceId: String, promise: Promise ->
      val device = usbManager.deviceList[deviceId] ?: throw DeviceNotFoundException()
      if (usbManager.hasPermission(device)) {
        promise.resolve(true)
        return@AsyncFunction
      }
      synchronized(waitingForPermission) {
        waitingForPermission.getOrPut(deviceId) { mutableListOf() }.add(promise)
      }
      // Android 14 refuses a mutable PendingIntent around an implicit intent, so
      // the intent names this package; and the system writes the answer into
      // it, so it must be mutable.
      val intent = Intent(ACTION_USB_PERMISSION).setPackage(context.packageName)
      val mutable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
      val pending = PendingIntent.getBroadcast(
        context,
        0,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or mutable
      )
      usbManager.requestPermission(device, pending)
    }

    AsyncFunction("open") Coroutine { deviceId: String, interfaceIndex: Int ->
      withContext(Dispatchers.IO) { open(deviceId, interfaceIndex) }
    }

    AsyncFunction("write") Coroutine { handle: Int, data: ByteArray ->
      // Copied before leaving this thread: the array belongs to the JS runtime
      // and may not outlive the call.
      val packet = data.copyOf()
      withContext(Dispatchers.IO) {
        val session = sessions[handle] ?: throw SessionClosedException()
        session.write(packet)
      }
    }

    AsyncFunction("close") { handle: Int ->
      sessions.remove(handle)?.close()
    }

    OnCreate {
      registerReceiver()
    }

    OnDestroy {
      receiver?.let {
        try {
          context.unregisterReceiver(it)
        } catch (e: Exception) {
          // Already gone along with the context.
        }
      }
      receiver = null
      sessions.values.forEach { it.close() }
      sessions.clear()
    }
  }

  // ---------------------------------------------------------------------------
  // Devices coming, going, and being allowed
  // ---------------------------------------------------------------------------

  private fun registerReceiver() {
    val context = appContext.reactContext ?: return
    val filter = IntentFilter().apply {
      addAction(ACTION_USB_PERMISSION)
      addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
      addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
    }
    val created = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        val device = IntentCompat.getParcelableExtra(intent, UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        when (intent.action) {
          ACTION_USB_PERMISSION -> answerPermission(device)
          UsbManager.ACTION_USB_DEVICE_DETACHED -> {
            if (device != null) {
              sessions.values.filter { it.deviceId == device.deviceName }.forEach { lost ->
                sessions.remove(lost.handle)
                lost.close()
              }
              // Nobody is left to answer a permission dialog for it.
              answerPermission(device)
            }
            emit(EVENT_DEVICES_CHANGED, mapOf("attached" to false))
          }
          UsbManager.ACTION_USB_DEVICE_ATTACHED ->
            emit(EVENT_DEVICES_CHANGED, mapOf("attached" to true))
        }
      }
    }
    // Not exported: the only senders are the system and the PendingIntent
    // above, which the system sends in this app's name.
    ContextCompat.registerReceiver(context, created, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    receiver = created
  }

  /**
   * Settles whoever asked about `device`, or everyone when the broadcast did
   * not say which device it was about. The answer is read back from the
   * system rather than taken from the intent's extras.
   */
  private fun answerPermission(device: UsbDevice?) {
    val settled: List<Pair<String, List<Promise>>>
    synchronized(waitingForPermission) {
      val ids = if (device != null) listOf(device.deviceName) else waitingForPermission.keys.toList()
      settled = ids.mapNotNull { id -> waitingForPermission.remove(id)?.let { id to it.toList() } }
    }
    for ((id, promises) in settled) {
      val current = usbManager.deviceList[id]
      val granted = current != null && usbManager.hasPermission(current)
      promises.forEach { it.resolve(granted) }
    }
  }

  private fun describe(device: UsbDevice): Map<String, Any?> {
    val interfaces = (0 until device.interfaceCount).map { index ->
      val usbInterface = device.getInterface(index)
      mapOf(
        "index" to index,
        "number" to usbInterface.id,
        "class" to usbInterface.interfaceClass,
        "subclass" to usbInterface.interfaceSubclass,
        "protocol" to usbInterface.interfaceProtocol,
        "endpoints" to (0 until usbInterface.endpointCount).map { e ->
          val endpoint = usbInterface.getEndpoint(e)
          mapOf(
            "address" to endpoint.address,
            "direction" to if (endpoint.direction == UsbConstants.USB_DIR_IN) "in" else "out",
            "type" to when (endpoint.type) {
              UsbConstants.USB_ENDPOINT_XFER_INT -> "interrupt"
              UsbConstants.USB_ENDPOINT_XFER_BULK -> "bulk"
              UsbConstants.USB_ENDPOINT_XFER_ISOC -> "isochronous"
              else -> "control"
            },
            "maxPacketSize" to endpoint.maxPacketSize
          )
        }
      )
    }
    return mapOf(
      "id" to device.deviceName,
      "vendorId" to device.vendorId,
      "productId" to device.productId,
      // The serial number is left out on purpose: reading it needs permission
      // on Android 10 and later, and nothing here uses it.
      "productName" to device.productName,
      "manufacturerName" to device.manufacturerName,
      "hasPermission" to usbManager.hasPermission(device),
      "interfaces" to interfaces
    )
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  private fun open(deviceId: String, interfaceIndex: Int): Map<String, Any> {
    val device = usbManager.deviceList[deviceId] ?: throw DeviceNotFoundException()
    if (!usbManager.hasPermission(device)) throw NoPermissionException()
    if (interfaceIndex < 0 || interfaceIndex >= device.interfaceCount) throw NoEndpointsException()

    val usbInterface = device.getInterface(interfaceIndex)
    var endpointIn: UsbEndpoint? = null
    var endpointOut: UsbEndpoint? = null
    for (i in 0 until usbInterface.endpointCount) {
      val endpoint = usbInterface.getEndpoint(i)
      val carriesPackets = endpoint.type == UsbConstants.USB_ENDPOINT_XFER_INT ||
        endpoint.type == UsbConstants.USB_ENDPOINT_XFER_BULK
      if (!carriesPackets) continue
      if (endpoint.direction == UsbConstants.USB_DIR_IN && endpointIn == null) endpointIn = endpoint
      if (endpoint.direction == UsbConstants.USB_DIR_OUT && endpointOut == null) endpointOut = endpoint
    }
    if (endpointIn == null || endpointOut == null) throw NoEndpointsException()

    // One conversation per device. A session left over from an abandoned
    // attempt would otherwise hold the interface and swallow the replies.
    sessions.values.filter { it.deviceId == deviceId }.forEach { stale ->
      sessions.remove(stale.handle)
      stale.close()
    }

    val connection = usbManager.openDevice(device) ?: throw OpenFailedException()
    // force = true takes the interface from the kernel's own HID driver.
    if (!connection.claimInterface(usbInterface, true)) {
      connection.close()
      throw ClaimFailedException()
    }

    val session = Session(nextHandle.getAndIncrement(), deviceId, connection, usbInterface, endpointIn, endpointOut)
    sessions[session.handle] = session
    session.start()
    return mapOf("handle" to session.handle, "packetSize" to endpointOut.maxPacketSize)
  }

  private inner class Session(
    val handle: Int,
    val deviceId: String,
    private val connection: UsbDeviceConnection,
    private val usbInterface: UsbInterface,
    private val endpointIn: UsbEndpoint,
    private val endpointOut: UsbEndpoint
  ) {
    @Volatile
    private var closed = false

    @Volatile
    private var request: UsbRequest? = null

    fun start() {
      thread(name = "usb-host-reader-$handle", isDaemon = true) { readLoop() }
    }

    /**
     * Reads with a queued request rather than bulkTransfer-with-timeout: a
     * transfer that times out part-way can lose the packet it was receiving,
     * whereas a queued request just stays pending until the device speaks.
     */
    private fun readLoop() {
      val size = endpointIn.maxPacketSize
      val reading = UsbRequest()
      try {
        if (!reading.initialize(connection, endpointIn)) return
        request = reading
        val buffer = ByteBuffer.allocate(size)
        while (!closed) {
          buffer.clear()
          val queued = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            reading.queue(buffer)
          } else {
            @Suppress("DEPRECATION")
            reading.queue(buffer, size)
          }
          if (!queued) break
          val finished = connection.requestWait()
          if (closed || finished == null) break
          if (finished !== reading) continue
          // Before Android 8 the buffer's position is not moved, and the
          // length received cannot be known — but these devices only ever
          // send whole packets.
          val length = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) buffer.position() else size
          if (length <= 0) continue
          val packet = ByteArray(length)
          buffer.rewind()
          buffer.get(packet)
          emit(EVENT_PACKET, mapOf("handle" to handle, "data" to toHex(packet)))
        }
      } catch (e: Exception) {
        if (!closed) Log.w(TAG, "reader for session $handle stopped: ${e.message}")
      } finally {
        request = null
        try {
          reading.close()
        } catch (e: Exception) {
          // Closing a request on a connection that has gone throws; nothing to do.
        }
        // A loop that ends on its own means the device went away.
        if (!closed) {
          sessions.remove(handle)
          close()
        }
        emit(EVENT_CLOSED, mapOf("handle" to handle))
      }
    }

    fun write(packet: ByteArray) {
      if (closed) throw SessionClosedException()
      // One writer at a time, so two messages can never interleave packets.
      synchronized(this) {
        val sent = connection.bulkTransfer(endpointOut, packet, packet.size, WRITE_TIMEOUT_MS)
        if (sent != packet.size) {
          if (closed) throw SessionClosedException()
          throw WriteFailedException()
        }
      }
    }

    fun close() {
      if (closed) return
      closed = true
      try {
        request?.cancel()
      } catch (e: Exception) {
        // The request has already completed or the device has gone.
      }
      try {
        connection.releaseInterface(usbInterface)
      } catch (e: Exception) {
        // Unplugged: there is no interface left to release.
      }
      try {
        connection.close()
      } catch (e: Exception) {
        // Likewise.
      }
    }
  }

  /** Events are sent from reader threads, which can outlive the JS runtime by a moment. */
  private fun emit(name: String, body: Map<String, Any?>) {
    try {
      sendEvent(name, body)
    } catch (e: Exception) {
      Log.w(TAG, "could not deliver $name: ${e.message}")
    }
  }

  private fun toHex(bytes: ByteArray): String {
    val digits = "0123456789abcdef"
    val out = StringBuilder(bytes.size * 2)
    for (b in bytes) {
      val v = b.toInt() and 0xff
      out.append(digits[v ushr 4]).append(digits[v and 0x0f])
    }
    return out.toString()
  }
}
