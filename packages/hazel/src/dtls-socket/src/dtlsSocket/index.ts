import { Socket } from "../../..";
import { BinaryObject, BinaryObjectInstance, BinaryReader, BinaryWriter } from "@autil/helpers";
import { AlertPacket } from "../packets/alert";
import { ClientHello } from "../packets/handshake/clientHello";
import { CipherSuite } from "../types/cipherSuite";
import { ProtocolVersion } from "../types/protocolVersion";
import { ContentType, DtlsRecordReader } from "../types/dtlsRecord/reader";
import { HandshakeReader, HandshakeType } from "../types/handshake/reader";
import { Random } from "../types/random";
import { HazelDtlsSessionInfo } from "../types/hazelDtlsSessionInfo";
import { Extension } from "../types/extension/extension";
import { EllipticCurveExtensionData } from "../types/extension/ellipticCurveExtension";
import { HelloVerifyRequest } from "../packets/handshake/helloVerifyRequest";
//@ts-ignore
import arrayBufferEquals from "arraybuffer-equal";
import { ServerHello } from "../packets/handshake/serverHello";
import { X25519EcdheRsaSha256 } from "../types/x25519EcdheRsaSha256";
import { Certificate } from "../packets/handshake/certificate";
import * as forge from "node-forge";
import { ServerKeyExchange } from "../packets/handshake/serverKeyExchange";
import * as x25519 from "@stablelib/x25519";
import { expandSecret } from "..";
import { Aes128GcmRecordProtection } from "./recordProtection";
import { ClientKeyExchange } from "../packets/handshake/clientKeyExchange";

enum HandshakeState {
  Initializing,
  ExpectingServerHello,
  ExpectingCertificate,
  ExpectingServerKeyExchange,
  ExpectingServerHelloDone,
  ExpectingChangeCipherSpec,
}

type EpochState = {
  epoch: number,
  state: HandshakeState,

  clientRandom: Random,
  serverRandom: Random,

  selectedCipherSuite: CipherSuite,
  cookie: ArrayBuffer,

  handshake?: X25519EcdheRsaSha256,
  serverCertificate?: forge.pki.Certificate

  recordProtection?: Aes128GcmRecordProtection,

  masterSecret: ArrayBuffer,
  serverVerification: ArrayBuffer,

  certificateFragments?: ArrayBuffer,
  certificateFragmentDataRecv: number,
  certificatePayload: ArrayBuffer,
}

export class DtlsSocket extends Socket {
  protected disconnectHandlers: Set<(reason?: string) => void> = new Set();
  protected recieveHandlers: Set<(buffer: ArrayBuffer) => void> = new Set();

  protected packetHandlers: Map<BinaryObject<BinaryObjectInstance, []>, Set<(t: BinaryObjectInstance) => void>> = new Map();

  protected recieveMap: Map<number, Map<number, BinaryObjectInstance>> = new Map();

  protected protocolVersion = ProtocolVersion.Obfuscated;
  protected epoch: number = 0;
  protected sequenceNumber: number = 1;

  protected epochState!: EpochState;

  protected handshakeSequence: number = 0;

  protected messagesBuffer: ArrayBuffer[] = [];

  constructor(protected readonly socket: Socket) {
    super();

    socket.addRecieveHandler(bin => {
      this.handleMessage(BinaryReader.from(bin).read(DtlsRecordReader));
    });

    this.resetConnectionState();
  }

  protected resetConnectionState() {
    this.epochState = {
      epoch: 1,
      state: HandshakeState.Initializing,
      selectedCipherSuite: CipherSuite.TLS_NULL_WITH_NULL_NULL,
      cookie: new ArrayBuffer(0),
      serverRandom: Random.NULL,
      clientRandom: Random.generate(),
      masterSecret: new ArrayBuffer(0),
      serverVerification: new ArrayBuffer(0),
      certificateFragmentDataRecv: 0,
      certificatePayload: new ArrayBuffer(0),
    }
  }

  addDisconnectHandler(handler: (reason?: string) => void): void {
    this.disconnectHandlers.add(handler);
  }

  addRecieveHandler(handler: (binary: ArrayBuffer) => void): void {
    this.recieveHandlers.add(handler);
  }

  protected emitDisconnect(reason?: string): void {
    this.disconnectHandlers.forEach(handler => handler(reason));
  }

  protected emitRecieve(binary: ArrayBuffer): void {
    this.recieveHandlers.forEach(handler => handler(binary));
  }

  send(binary: ArrayBuffer): void {
    throw new Error("TODO");
  }

  protected handleMessage(message: DtlsRecordReader): void {
    console.log("DTLS Record (" + ContentType[message.getContentType()] + ")")

    if (message.getContentType() === ContentType.Alert) {
      const alert = AlertPacket.deserialize(message);

      if (alert.isFatal()) {
        this.emitDisconnect(`DTLS Alert: ${alert.toString()}`);
        return;
      }

      console.log(alert.toString());
      return;
    }

    if (message.getContentType() === ContentType.Handshake) {
      while (message.hasBytesLeftToRead()) {
        this.handleHandshake(message.read(HandshakeReader));
      }
      return;
    }
  }

  protected handleHandshake(message: HandshakeReader) {
    console.log("DTLS Handshake (" + HandshakeType[message.getHandshakeType()] + ")");

    this.handshakeSequence = message.getMessageSequence();

    switch(message.getHandshakeType()) {
      case HandshakeType.HelloVerifyRequest:
        return this.handleHelloVerifyRequest(HelloVerifyRequest.deserialize(message));
      case HandshakeType.ServerHello:
        return this.handleServerHello(ServerHello.deserialize(message));
      case HandshakeType.Certificate:
        if (message.getFullLength() == message.getBuffer().byteLength) {
          this.handleCertificate(Certificate.deserialize(message));
        } else {
          if (!this.epochState.certificateFragments)
            this.epochState.certificateFragments = new ArrayBuffer(message.getFullLength());

          new Uint8Array(this.epochState.certificateFragments).set(new Uint8Array(message.getBuffer().buffer), message.getFragmentOffset());

          this.epochState.certificateFragmentDataRecv += message.getBuffer().byteLength;

          if (this.epochState.certificateFragmentDataRecv === message.getFullLength()) {
            this.handleCertificate(Certificate.deserialize(BinaryReader.from(this.epochState.certificateFragments)))
            this.epochState.certificateFragments = undefined;
            this.epochState.certificateFragmentDataRecv = 0;
          }
        }
        break;
      case HandshakeType.ServerKeyExchange:
        return this.handleServerKeyExchange(ServerKeyExchange.deserialize(message));
      case HandshakeType.ServerHelloDone:
        return this.handleServerHelloDone();
    }
  }

  protected handleServerHelloDone() {
    if (this.epochState.state !== HandshakeState.ExpectingServerHelloDone) {
      console.log("invalid state");
      return;
    }

    this.epochState.state = HandshakeState.ExpectingChangeCipherSpec;

    this.sendClientKeyExchangeFlight()
  }

  protected handleServerKeyExchange(keyExchange: ServerKeyExchange) {
    if (keyExchange.getCurveType() !== 0x03) { // ECCurveType.NamedCurve
      console.log("Unsupported curve type");
      return;
    }

    if (keyExchange.getSelectedCurve() !== 0x001d) { // NamedCurve.x25519
      console.log("Unsupported selected curve");
      return;
    }

    if (keyExchange.getHashAlgorithm() !== 0x04) { // HashAlgorithm.Sha256
      console.log("Unsupported hash algorithm");
      return;
    }

    if (keyExchange.getSignatureAlgorithm() !== 0x01) { // SignatureAlgorithm.RSA
      console.log("Unsupported signature algorithm");
      return;
    }

    if (this.epochState.serverCertificate === undefined) {
      console.log("state error: missing public key");
      return;
    }

    const keyAndParameters = keyExchange.serialize().getBuffer().buffer.slice(0, 4 + keyExchange.getKey().byteLength);

    const md = forge.md.sha256.create();

    md.update(forge.util.binary.raw.encode(new Uint8Array(keyAndParameters)), "raw");

    const signature = forge.util.binary.raw.encode(new Uint8Array(keyExchange.getSignature()));

    const result = (this.epochState.serverCertificate.publicKey as forge.pki.rsa.PublicKey).verify(md.digest().bytes(), signature, "RSASSA-PKCS1-V1_5");

    if (!result) {
      console.log("signature failure");
      return;
    }

    const res = x25519.scalarMult(
      new Uint8Array(this.epochState.clientRandom.serialize().getBuffer().buffer),
      new Uint8Array(keyExchange.getKey())
    );

    const randomSeed = BinaryWriter.allocate(64);
    randomSeed.write(this.epochState.clientRandom);
    randomSeed.write(this.epochState.serverRandom);

    const labelEncoder = new TextEncoder();

    // intentional typo due to typo in upstream https://github.com/willardf/Hazel-Networking/
    const masterSecret = expandSecret(res, labelEncoder.encode("master secert"), new Uint8Array(randomSeed.getBuffer().buffer))

    if (this.epochState.selectedCipherSuite.equals(CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256)) {
      this.epochState.recordProtection = new Aes128GcmRecordProtection(
        masterSecret,
        this.epochState.serverRandom.serialize().getBuffer().buffer,
        this.epochState.clientRandom.serialize().getBuffer().buffer
      )
    } else {
      console.log("Unsupported cipher suite");
      return;
    }

    this.epochState.state = HandshakeState.ExpectingServerHelloDone;
    this.epochState.masterSecret = masterSecret;
  }

  protected handleCertificate(certificate: Certificate) {
    if (certificate.getCertificate().publicKey === undefined) {
      console.log("Dropping malfomed Certificate message: Certificate is not RSA signed");
      return;
    }

    this.epochState.serverCertificate = certificate.getCertificate();
    this.epochState.state = HandshakeState.ExpectingServerKeyExchange;
  }

  protected handleServerHello(hello: ServerHello) {
    if (this.epochState.state != HandshakeState.ExpectingServerHello) {
      console.log("Dropping unexpected ServerHello handshake message. State(" + HandshakeState[this.epochState.state] + ")");
      return;
    }

    if (hello.getCipherSuite().equals(CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256)) {
      this.epochState.handshake = new X25519EcdheRsaSha256();
    } else {
      console.log("Dropping malformed ServerHello message. Unsupported CiperSuite");
    }

    this.epochState.selectedCipherSuite = hello.getCipherSuite();
    this.epochState.state = HandshakeState.ExpectingCertificate;
    this.epochState.certificateFragments = undefined;
    this.epochState.certificateFragmentDataRecv = 0;
    this.epochState.certificatePayload = new ArrayBuffer(0);
  }

  protected handleHelloVerifyRequest(request: HelloVerifyRequest) {
    if (this.epochState.state != HandshakeState.ExpectingServerHello) {
      console.log("Dropping unexpected HelloVerifyRequest handshake message. State(" + HandshakeState[this.epochState.state] + ")");
      return;
    }

    if (arrayBufferEquals(this.epochState.cookie, request.getCookie())) {
      console.log("Dropping duplicate HelloVerifyRequest handshake message");
      return;
    }

    this.epochState.cookie = request.getCookie();

    this.sendClientHello();
  }

  protected incrementEpoch() { this.epoch++; this.sequenceNumber = 1 }

  protected sendDtlsMessage(type: ContentType, message: BinaryWriter | BinaryReader): void {
    const writer = DtlsRecordReader.fromRecord(type, this.protocolVersion, this.epoch, this.sequenceNumber++, message.getBuffer().buffer)

    this.messagesBuffer.push(writer.serialize().getBuffer().buffer);

    this.socket.send(writer.serialize().getBuffer().buffer);
  }

  protected sendHandshakeMessage(...messages: (BinaryObjectInstance & { getType(): HandshakeType })[]): void {
    const writer = BinaryWriter.allocate(0);

    for (const message of messages) {
      const buf = message.serialize().getBuffer().buffer;

      const handshakeReader = HandshakeReader.fromHandshake(message.getType(), this.handshakeSequence++, 0, buf.byteLength, buf);

      writer.writeBytes(handshakeReader.serialize());
    }

    this.sendDtlsMessage(ContentType.Handshake, writer);
  }

  protected addOncePacketHandler<T extends BinaryObject<BinaryObjectInstance, []>>(packetType: T, handler: (pkt: BinaryObjectInstance) => void) {
    if (!this.packetHandlers.has(packetType))
      this.packetHandlers.set(packetType, new Set());

    let selfHandler: (pkt: BinaryObjectInstance) => void;

    selfHandler = (pkt: BinaryObjectInstance) => {
      this.packetHandlers.get(packetType)?.delete(selfHandler);
      handler(pkt);
    }

    this.packetHandlers.get(packetType)!.add(selfHandler);
  }

  protected waitForHandshake<T extends BinaryObject<BinaryObjectInstance, []>>(packetType: T): Promise<T["prototype"]> {
    return new Promise((res, rej) => {
      this.addOncePacketHandler(packetType, pkt => {
        res(pkt);
      })
    })
  }

  protected clearMessagesBuffer() {
    this.messagesBuffer = [];
  }

  async connect(): Promise<void> {
    await this.socket.connect();

    await new Promise((res, rej) => {
      this._connect().then(res, rej);

      this.addDisconnectHandler(rej);
    })
  }

  protected sendClientKeyExchangeFlight() {
    const cke = new ClientKeyExchange(
      x25519.scalarMultBase(
        new Uint8Array(this.epochState.clientRandom.serialize().getBuffer().buffer)
      )
    )

    const buf = cke.serialize().getBuffer().buffer;

    const handshakeReader = HandshakeReader.fromHandshake(cke.getType(), this.handshakeSequence++, 0, buf.byteLength, buf);
    const cker = DtlsRecordReader.fromRecord(ContentType.Handshake, this.protocolVersion, this.epoch, this.sequenceNumber++, handshakeReader.serialize().getBuffer().buffer);
    const ccsr = DtlsRecordReader.fromRecord(ContentType.ChangeCipherSpec, this.protocolVersion, this.epoch, this.sequenceNumber++, new Uint8Array([1]).buffer);

    this.incrementEpoch();

    const handshakeReader2 = HandshakeReader.fromHandshake(HandshakeType.Finished, this.handshakeSequence++, 0, 0, new Uint8Array([1]).buffer)
    const fhr = this.epochState.recordProtection!.encryptClientPlaintext(DtlsRecordReader.fromRecord(ContentType.Handshake, this.protocolVersion, this.epoch, this.sequenceNumber++, handshakeReader2.serialize().getBuffer().buffer));
    const serializedCker = cker.serialize();
    const serializedCcsr = ccsr.serialize();
    const serializedFhr = fhr.serialize();

    const writer = BinaryWriter.allocate(serializedCcsr.getBuffer().byteLength + serializedCker.getBuffer().byteLength + serializedFhr.getBuffer().byteLength);

    writer.writeBytes(serializedCker);
    writer.writeBytes(serializedCcsr);
    writer.writeBytes(serializedFhr);

    this.socket.send(writer.getBuffer().buffer);
  }

  protected sendClientHello(retransmitting: boolean = false): void {
    this.sendHandshakeMessage(new ClientHello(
      this.protocolVersion,
      this.epochState.clientRandom,
      new HazelDtlsSessionInfo(1),
      this.epochState.cookie,
      [CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256],
      [0x00],
      [
        new Extension(10, new EllipticCurveExtensionData([0x001d]).serialize().getBuffer().buffer)
      ],
    ));

    if (!retransmitting) {
      //TODO: VerificationStream

      this.epochState.state = HandshakeState.ExpectingServerHello
    }
  }

  protected async _connect(): Promise<void> {
    this.resetConnectionState();
    this.sendClientHello();

    await new Promise(r => {});
  }
}