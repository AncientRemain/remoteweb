// beam-pad: virtual Xbox 360 controllers for Beam Remote, through the ViGEmBus driver
// (the same driver Sunshine, Parsec-style tools and DS4Windows use). Games see them as real
// wired Xbox 360 controllers.
//
// One line per message on stdin / stdout:
//   in   plug <slot>                                  -> plugged <slot> <player 1-4 or 0>
//        state <slot> <buttons> <lt> <rt> <lx> <ly> <rx> <ry>
//        unplug <slot>
//        quit
//   out  ready | nodriver <reason>
//        plugged <slot> <player> | error <slot> <message>
//        rumble <slot> <large 0-255> <small 0-255>
// Exits (unplugging everything) when stdin closes.
// Build: csc /nologo /optimize /target:exe /out:beam-pad.exe Program.cs
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace BeamPad
{
    static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct SP_DEVICE_INTERFACE_DATA { public uint cbSize; public Guid InterfaceClassGuid; public uint Flags; public IntPtr Reserved; }

        [DllImport("setupapi.dll", SetLastError = true)]
        public static extern IntPtr SetupDiGetClassDevs(ref Guid classGuid, IntPtr enumerator, IntPtr hwndParent, uint flags);
        [DllImport("setupapi.dll", SetLastError = true)]
        public static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr devInfo, ref Guid classGuid, uint index, ref SP_DEVICE_INTERFACE_DATA data);
        [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr set, ref SP_DEVICE_INTERFACE_DATA data, IntPtr detail, uint detailSize, out uint required, IntPtr devInfo);
        [DllImport("setupapi.dll")]
        public static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool DeviceIoControl(SafeFileHandle h, uint code, IntPtr inBuf, uint inSize, IntPtr outBuf, uint outSize, out uint returned, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetOverlappedResult(SafeFileHandle h, IntPtr overlapped, out uint transferred, bool wait);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr CreateEvent(IntPtr security, bool manualReset, bool initialState, string name);
        [DllImport("kernel32.dll")]
        public static extern bool CloseHandle(IntPtr h);
    }

    class Target
    {
        public int Slot;
        public uint Serial;
        public volatile bool Alive = true;
        public int LastLarge = -1, LastSmall = -1;
    }

    static class Program
    {
        // From ViGEmClient's BusShared.h (MIT, Nefarius Software Solutions e.U. and contributors).
        static Guid BusInterface = new Guid("96E42B22-F5E9-42F8-B043-ED0F932F014F");
        const uint IOCTL_PLUGIN = 0x2AA004, IOCTL_UNPLUG = 0x2AA008, IOCTL_CHECK_VERSION = 0x2AA00C, IOCTL_WAIT_READY = 0x2AA010;
        const uint IOCTL_XUSB_NOTIFY = 0x2AE804, IOCTL_XUSB_SUBMIT = 0x2AA808, IOCTL_XUSB_USER_INDEX = 0x2AE81C;
        const uint VIGEM_COMMON_VERSION = 0x0001;
        const ushort X360_VID = 0x045E, X360_PID = 0x028E;

        static SafeFileHandle bus;
        static readonly object outLock = new object();
        static readonly Dictionary<int, Target> targets = new Dictionary<int, Target>();

        static void Say(string line) { lock (outLock) { try { Console.Out.WriteLine(line); Console.Out.Flush(); } catch { } } }

        static int Main(string[] args)
        {
            string reason;
            if (!Open(out reason)) { Say("nodriver " + reason); return 2; }
            Say("ready");
            string line;
            while ((line = ReadLine()) != null)
            {
                string[] p = line.Trim().Split(' ');
                if (p.Length == 0 || p[0].Length == 0) continue;
                try
                {
                    if (p[0] == "plug" && p.Length >= 2) Plug(int.Parse(p[1]));
                    else if (p[0] == "state" && p.Length >= 9) Submit(int.Parse(p[1]), ushort.Parse(p[2]), byte.Parse(p[3]), byte.Parse(p[4]), short.Parse(p[5]), short.Parse(p[6]), short.Parse(p[7]), short.Parse(p[8]));
                    else if (p[0] == "unplug" && p.Length >= 2) Unplug(int.Parse(p[1]));
                    else if (p[0] == "quit") break;
                }
                catch (Exception e) { Say("error " + (p.Length > 1 ? p[1] : "-") + " " + e.Message.Replace('\n', ' ')); }
            }
            foreach (int slot in new List<int>(targets.Keys)) { try { Unplug(slot); } catch { } }
            return 0;
        }

        static string ReadLine() { try { return Console.In.ReadLine(); } catch { return null; } }

        // Finds the ViGEmBus device and checks it speaks our protocol version.
        static bool Open(out string reason)
        {
            reason = "";
            IntPtr set = Native.SetupDiGetClassDevs(ref BusInterface, IntPtr.Zero, IntPtr.Zero, 0x02 | 0x10); // PRESENT | DEVICEINTERFACE
            if (set == IntPtr.Zero || set == new IntPtr(-1)) { reason = "not-installed"; return false; }
            string path = null;
            try
            {
                var data = new Native.SP_DEVICE_INTERFACE_DATA();
                data.cbSize = (uint)Marshal.SizeOf(typeof(Native.SP_DEVICE_INTERFACE_DATA));
                if (!Native.SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref BusInterface, 0, ref data)) { reason = "not-installed"; return false; }
                uint required;
                Native.SetupDiGetDeviceInterfaceDetail(set, ref data, IntPtr.Zero, 0, out required, IntPtr.Zero);
                IntPtr detail = Marshal.AllocHGlobal((int)required);
                try
                {
                    Marshal.WriteInt32(detail, IntPtr.Size == 8 ? 8 : 6);
                    if (!Native.SetupDiGetDeviceInterfaceDetail(set, ref data, detail, required, out required, IntPtr.Zero)) { reason = "no-path"; return false; }
                    path = Marshal.PtrToStringUni(new IntPtr(detail.ToInt64() + 4));
                }
                finally { Marshal.FreeHGlobal(detail); }
            }
            finally { Native.SetupDiDestroyDeviceInfoList(set); }

            // GENERIC_READ|GENERIC_WRITE, share read/write, OPEN_EXISTING, NORMAL|NO_BUFFERING|WRITE_THROUGH|OVERLAPPED
            bus = Native.CreateFile(path, 0xC0000000, 0x3, IntPtr.Zero, 3, 0x80 | 0x20000000 | 0x80000000 | 0x40000000, IntPtr.Zero);
            if (bus.IsInvalid) { reason = "open-failed-" + Marshal.GetLastWin32Error(); return false; }

            IntPtr buf = Marshal.AllocHGlobal(8);
            try
            {
                Marshal.WriteInt32(buf, 0, 8);
                Marshal.WriteInt32(buf, 4, (int)VIGEM_COMMON_VERSION);
                int err;
                if (!Ioctl(IOCTL_CHECK_VERSION, buf, 8, IntPtr.Zero, 0, out err)) { reason = "version-" + err; return false; }
            }
            finally { Marshal.FreeHGlobal(buf); }
            return true;
        }

        // DeviceIoControl on the overlapped handle, waiting for completion.
        static bool Ioctl(uint code, IntPtr inBuf, int inSize, IntPtr outBuf, int outSize, out int error)
        {
            int ovSize = IntPtr.Size == 8 ? 32 : 20;
            IntPtr ov = Marshal.AllocHGlobal(ovSize);
            IntPtr ev = Native.CreateEvent(IntPtr.Zero, true, false, null);
            try
            {
                for (int i = 0; i < ovSize; i++) Marshal.WriteByte(ov, i, 0);
                Marshal.WriteIntPtr(ov, IntPtr.Size == 8 ? 24 : 16, ev);
                uint returned;
                bool ok = Native.DeviceIoControl(bus, code, inBuf, (uint)inSize, outBuf, (uint)outSize, out returned, ov);
                error = 0;
                if (!ok)
                {
                    error = Marshal.GetLastWin32Error();
                    if (error == 997) // ERROR_IO_PENDING
                    {
                        uint transferred;
                        ok = Native.GetOverlappedResult(bus, ov, out transferred, true);
                        error = ok ? 0 : Marshal.GetLastWin32Error();
                    }
                }
                return ok;
            }
            finally { Native.CloseHandle(ev); Marshal.FreeHGlobal(ov); }
        }

        static void Plug(int slot)
        {
            if (targets.ContainsKey(slot)) { Say("plugged " + slot + " " + PlayerOf(targets[slot])); return; }
            IntPtr buf = Marshal.AllocHGlobal(16);
            uint serial = 0;
            int err = 0;
            try
            {
                // The bus hands out serial numbers; the first free one wins.
                for (uint s = 1; s <= 16 && serial == 0; s++)
                {
                    Marshal.WriteInt32(buf, 0, 16);
                    Marshal.WriteInt32(buf, 4, (int)s);
                    Marshal.WriteInt32(buf, 8, 0); // Xbox360Wired
                    Marshal.WriteInt16(buf, 12, (short)X360_VID);
                    Marshal.WriteInt16(buf, 14, (short)X360_PID);
                    if (Ioctl(IOCTL_PLUGIN, buf, 16, IntPtr.Zero, 0, out err)) serial = s;
                }
            }
            finally { Marshal.FreeHGlobal(buf); }
            if (serial == 0) { Say("error " + slot + " plug-failed-" + err); return; }

            IntPtr wait = Marshal.AllocHGlobal(8);
            try
            {
                Marshal.WriteInt32(wait, 0, 8);
                Marshal.WriteInt32(wait, 4, (int)serial);
                int ignored;
                Ioctl(IOCTL_WAIT_READY, wait, 8, IntPtr.Zero, 0, out ignored); // older buses don't have it
            }
            finally { Marshal.FreeHGlobal(wait); }

            var t = new Target { Slot = slot, Serial = serial };
            targets[slot] = t;
            var th = new Thread(() => Notifications(t)) { IsBackground = true };
            th.Start();
            int player = 0;
            for (int i = 0; i < 10 && player == 0; i++) { player = PlayerOf(t); if (player == 0) Thread.Sleep(50); }
            Say("plugged " + slot + " " + player);
        }

        // 1-4 = the player light Windows gave this controller (0 = not known yet).
        static int PlayerOf(Target t)
        {
            IntPtr buf = Marshal.AllocHGlobal(12);
            try
            {
                Marshal.WriteInt32(buf, 0, 12);
                Marshal.WriteInt32(buf, 4, (int)t.Serial);
                Marshal.WriteInt32(buf, 8, 0);
                int err;
                if (!Ioctl(IOCTL_XUSB_USER_INDEX, buf, 12, buf, 12, out err)) return 0;
                return Marshal.ReadInt32(buf, 8) + 1;
            }
            finally { Marshal.FreeHGlobal(buf); }
        }

        static void Submit(int slot, ushort buttons, byte lt, byte rt, short lx, short ly, short rx, short ry)
        {
            Target t;
            if (!targets.TryGetValue(slot, out t)) return;
            IntPtr buf = Marshal.AllocHGlobal(20);
            try
            {
                Marshal.WriteInt32(buf, 0, 20);
                Marshal.WriteInt32(buf, 4, (int)t.Serial);
                Marshal.WriteInt16(buf, 8, (short)buttons);
                Marshal.WriteByte(buf, 10, lt);
                Marshal.WriteByte(buf, 11, rt);
                Marshal.WriteInt16(buf, 12, lx);
                Marshal.WriteInt16(buf, 14, ly);
                Marshal.WriteInt16(buf, 16, rx);
                Marshal.WriteInt16(buf, 18, ry);
                int err;
                Ioctl(IOCTL_XUSB_SUBMIT, buf, 20, IntPtr.Zero, 0, out err);
            }
            finally { Marshal.FreeHGlobal(buf); }
        }

        // Waits for games to set vibration (and the player light) and reports changes.
        static void Notifications(Target t)
        {
            IntPtr buf = Marshal.AllocHGlobal(12);
            try
            {
                while (t.Alive)
                {
                    Marshal.WriteInt32(buf, 0, 12);
                    Marshal.WriteInt32(buf, 4, (int)t.Serial);
                    Marshal.WriteInt32(buf, 8, 0);
                    int err;
                    if (!Ioctl(IOCTL_XUSB_NOTIFY, buf, 12, buf, 12, out err)) { if (!t.Alive) break; Thread.Sleep(200); continue; }
                    if (!t.Alive) break;
                    int large = Marshal.ReadByte(buf, 8), small = Marshal.ReadByte(buf, 9);
                    if (large != t.LastLarge || small != t.LastSmall)
                    {
                        t.LastLarge = large; t.LastSmall = small;
                        Say("rumble " + t.Slot + " " + large + " " + small);
                    }
                }
            }
            finally { Marshal.FreeHGlobal(buf); }
        }

        static void Unplug(int slot)
        {
            Target t;
            if (!targets.TryGetValue(slot, out t)) return;
            targets.Remove(slot);
            t.Alive = false;
            Submit0(t);
            IntPtr buf = Marshal.AllocHGlobal(8);
            try
            {
                Marshal.WriteInt32(buf, 0, 8);
                Marshal.WriteInt32(buf, 4, (int)t.Serial);
                int err;
                Ioctl(IOCTL_UNPLUG, buf, 8, IntPtr.Zero, 0, out err);
            }
            finally { Marshal.FreeHGlobal(buf); }
        }

        // Neutral report before unplugging, so no button stays held in a game.
        static void Submit0(Target t)
        {
            targets[t.Slot] = t;
            try { Submit(t.Slot, 0, 0, 0, 0, 0, 0, 0); } finally { targets.Remove(t.Slot); }
        }
    }
}
