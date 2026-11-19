// beam-audio: captures what this PC is playing (WASAPI loopback of the default speakers)
// and writes it to stdout as packets of 32-bit float stereo PCM.
//
// Packet: uint32 magic 'BAUD' | uint32 sampleRate | uint32 channels (2) | uint32 frames | float32[frames*2]
// Status lines go to stderr. Exits (restoring the speaker mute state) when stdin closes.
//   beam-audio.exe [--mute]     --mute silences this PC's speakers while capturing
// Build: csc /nologo /optimize /target:exe /out:beam-audio.exe Program.cs
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace BeamAudio
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorCom { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int access, out IntPtr props);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int GetChannelCount(out uint count);
        [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid ctx);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
        [PreserveSig] int GetMasterVolumeLevel(out float level);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig] int SetChannelVolumeLevel(uint channel, float level, ref Guid ctx);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid ctx);
        [PreserveSig] int GetChannelVolumeLevel(uint channel, out float level);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    static class Program
    {
        const int CLSCTX_ALL = 23;
        const int eRender = 0, eConsole = 0;
        const int AUDCLNT_SHAREMODE_SHARED = 0;
        const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        const int AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = unchecked((int)0x80000000);
        const int AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
        const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
        const uint MAGIC = 0x44554142; // "BAUD"
        static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        static readonly Guid IID_IAudioEndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        static readonly Guid FLOAT_SUBTYPE = new Guid("00000003-0000-0010-8000-00aa00389b71");

        static volatile bool quit;
        static Stream stdout;
        static bool wantMute;
        static IAudioEndpointVolume volume;
        static bool mutedByUs;

        static void Log(string s) { try { Console.Error.WriteLine(s); Console.Error.Flush(); } catch { } }

        static int Main(string[] args)
        {
            wantMute = Array.IndexOf(args, "--mute") >= 0;
            stdout = Console.OpenStandardOutput();
            // When the app goes away (or closes our stdin), stop and restore the speakers.
            var watcher = new Thread(() => { try { var s = Console.OpenStandardInput(); var b = new byte[64]; while (s.Read(b, 0, b.Length) > 0) { } } catch { } quit = true; });
            watcher.IsBackground = true;
            watcher.Start();
            while (!quit)
            {
                try { Capture(); }
                catch (Exception e) { Log("error " + e.Message); }
                RestoreMute();
                if (!quit) Thread.Sleep(800); // device changed or vanished: try again
            }
            RestoreMute();
            return 0;
        }

        static void RestoreMute()
        {
            if (volume != null && mutedByUs) { try { var g = Guid.Empty; volume.SetMute(false, ref g); } catch { } }
            mutedByUs = false;
            volume = null;
        }

        static void Check(int hr, string what) { if (hr < 0) throw new Exception(what + " failed 0x" + hr.ToString("X8")); }

        static void Capture()
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
            IMMDevice device;
            Check(enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out device), "GetDefaultAudioEndpoint");
            string deviceId; device.GetId(out deviceId);

            object o; var iid = IID_IAudioClient;
            Check(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o), "Activate");
            var client = (IAudioClient)o;

            IntPtr mix;
            Check(client.GetMixFormat(out mix), "GetMixFormat");
            int tag = Marshal.ReadInt16(mix, 0) & 0xFFFF;
            int channels = Marshal.ReadInt16(mix, 2);
            int rate = Marshal.ReadInt32(mix, 4);
            int blockAlign = Marshal.ReadInt16(mix, 12);
            int bits = Marshal.ReadInt16(mix, 14);
            bool isFloat = tag == 3;
            if (tag == 0xFFFE)
            {
                var sub = new byte[16]; Marshal.Copy(mix + 24, sub, 0, 16);
                isFloat = new Guid(sub) == FLOAT_SUBTYPE;
            }

            const long bufferHns = 2000000; // 200 ms
            int hr = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, bufferHns, 0, mix, IntPtr.Zero);
            if (hr < 0)
            {
                // Some drivers refuse their own mix format for loopback; ask Windows to convert to plain float stereo 48 kHz.
                Log("init with mix format failed 0x" + hr.ToString("X8") + ", trying converted float");
                Marshal.Release(Marshal.GetIUnknownForObject(client));
                Check(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o), "Activate");
                client = (IAudioClient)o;
                IntPtr fmt = Marshal.AllocCoTaskMem(18);
                Marshal.WriteInt16(fmt, 0, 3); Marshal.WriteInt16(fmt, 2, 2); Marshal.WriteInt32(fmt, 4, 48000);
                Marshal.WriteInt32(fmt, 8, 48000 * 8); Marshal.WriteInt16(fmt, 12, 8); Marshal.WriteInt16(fmt, 14, 32); Marshal.WriteInt16(fmt, 16, 0);
                Check(client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, bufferHns, 0, fmt, IntPtr.Zero), "Initialize(converted)");
                tag = 3; channels = 2; rate = 48000; blockAlign = 8; bits = 32; isFloat = true;
            }
            Log("format " + rate + " Hz " + channels + " ch " + bits + "-bit " + (isFloat ? "float" : "int"));

            object c; var iidc = IID_IAudioCaptureClient;
            Check(client.GetService(ref iidc, out c), "GetService");
            var capture = (IAudioCaptureClient)c;

            if (wantMute)
            {
                try
                {
                    object v; var iidv = IID_IAudioEndpointVolume;
                    if (device.Activate(ref iidv, CLSCTX_ALL, IntPtr.Zero, out v) >= 0)
                    {
                        volume = (IAudioEndpointVolume)v;
                        bool was; volume.GetMute(out was);
                        if (!was) { var g = Guid.Empty; volume.SetMute(true, ref g); mutedByUs = true; }
                    }
                }
                catch (Exception e) { Log("mute failed " + e.Message); }
            }

            Check(client.Start(), "Start");
            Log("capturing");

            var clock = Stopwatch.StartNew();
            long sent = 0;          // frames written so far
            long baseTicks = 0;     // clock offset so "expected" lines up with "sent"
            var lastDeviceCheck = clock.ElapsedMilliseconds;
            float[] samples = new float[0];
            byte[] packet = new byte[0];

            while (!quit)
            {
                uint next;
                hr = capture.GetNextPacketSize(out next);
                if (hr < 0) throw new Exception("device lost 0x" + hr.ToString("X8"));
                if (next == 0)
                {
                    // Nothing playing: keep time with silence so the stream stays continuous.
                    long expected = (clock.ElapsedTicks - baseTicks) * rate / Stopwatch.Frequency;
                    long gap = expected - sent;
                    if (gap > rate / 50) WritePacket(ref samples, ref packet, rate, IntPtr.Zero, (int)Math.Min(gap, rate / 10), 0, false, 0, ref sent);
                    if (clock.ElapsedMilliseconds - lastDeviceCheck > 1500)
                    {
                        lastDeviceCheck = clock.ElapsedMilliseconds;
                        IMMDevice now; string nowId = null;
                        if (enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out now) >= 0) now.GetId(out nowId);
                        if (nowId != null && nowId != deviceId) { Log("default speakers changed"); break; }
                    }
                    Thread.Sleep(4);
                    continue;
                }
                IntPtr data; uint frames, flags; ulong pos, qpc;
                Check(capture.GetBuffer(out data, out frames, out flags, out pos, out qpc), "GetBuffer");
                bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
                WritePacket(ref samples, ref packet, rate, silent ? IntPtr.Zero : data, (int)frames, channels, isFloat, bits, ref sent);
                capture.ReleaseBuffer(frames);
                // If real audio came in after we filled silence, don't let the clock run behind.
                long exp2 = (clock.ElapsedTicks - baseTicks) * rate / Stopwatch.Frequency;
                if (sent - exp2 > rate / 10) baseTicks = clock.ElapsedTicks - sent * Stopwatch.Frequency / rate;
            }
            client.Stop();
            RestoreMute();
        }

        // Converts one buffer to float stereo and writes it as a packet.
        static void WritePacket(ref float[] samples, ref byte[] packet, int rate, IntPtr data, int frames, int channels, bool isFloat, int bits, ref long sent)
        {
            if (frames <= 0) return;
            int n = frames * 2;
            if (samples.Length < n) samples = new float[n];
            if (data == IntPtr.Zero) Array.Clear(samples, 0, n);
            else
            {
                int bytesPer = bits / 8;
                int stride = channels * bytesPer;
                var raw = new byte[frames * stride];
                Marshal.Copy(data, raw, 0, raw.Length);
                for (int f = 0; f < frames; f++)
                {
                    float l = Sample(raw, f * stride, isFloat, bits);
                    float r = channels > 1 ? Sample(raw, f * stride + bytesPer, isFloat, bits) : l;
                    if (channels >= 6)
                    {
                        // 5.1 / 7.1: fold centre and surrounds into stereo
                        float centre = Sample(raw, f * stride + 2 * bytesPer, isFloat, bits) * 0.707f;
                        float sl = Sample(raw, f * stride + 4 * bytesPer, isFloat, bits) * 0.5f;
                        float sr = Sample(raw, f * stride + 5 * bytesPer, isFloat, bits) * 0.5f;
                        l = (l + centre + sl) * 0.6f; r = (r + centre + sr) * 0.6f;
                    }
                    samples[f * 2] = l; samples[f * 2 + 1] = r;
                }
            }
            int size = 16 + n * 4;
            if (packet.Length < size) packet = new byte[size];
            BitConverter.GetBytes(MAGIC).CopyTo(packet, 0);
            BitConverter.GetBytes((uint)rate).CopyTo(packet, 4);
            BitConverter.GetBytes((uint)2).CopyTo(packet, 8);
            BitConverter.GetBytes((uint)frames).CopyTo(packet, 12);
            Buffer.BlockCopy(samples, 0, packet, 16, n * 4);
            stdout.Write(packet, 0, size);
            stdout.Flush();
            sent += frames;
        }

        static float Sample(byte[] b, int i, bool isFloat, int bits)
        {
            if (isFloat) return bits == 64 ? (float)BitConverter.ToDouble(b, i) : BitConverter.ToSingle(b, i);
            if (bits == 16) return BitConverter.ToInt16(b, i) / 32768f;
            if (bits == 24) return ((b[i] << 8 | b[i + 1] << 16 | b[i + 2] << 24) >> 8) / 8388608f;
            if (bits == 32) return BitConverter.ToInt32(b, i) / 2147483648f;
            return 0;
        }
    }
}
