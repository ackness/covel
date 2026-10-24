using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

// The launcher is created suspended, assigned to our kill-on-close job, then
// resumed. No child can escape ownership between launch and job assignment.
public sealed class WindowsSmokeProcess : IDisposable
{
    [StructLayout(LayoutKind.Sequential)] struct StartupInfo {
        public uint cb; public IntPtr reserved, desktop, title;
        public uint x, y, width, height, charsX, charsY, fill, flags;
        public ushort show, reservedSize; public IntPtr reservedBytes, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr process, thread; public uint processId, threadId;
    }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long processTime, jobTime; public uint flags;
        public UIntPtr minWorkingSet, maxWorkingSet; public uint activeLimit;
        public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong readOperations, writeOperations, otherOperations, readBytes, writeBytes, otherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits basic; public IoCounters io;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long userTime, kernelTime, periodUserTime, periodKernelTime;
        public uint pageFaults, totalProcesses, activeProcesses, terminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Rect {
        public int left, top, right, bottom;
    }
    delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool belongs);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int length);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out uint value, uint size);
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rectangle);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    IntPtr job, process;
    public uint Id { get; private set; }
    public WindowsSmokeProcess(string executable, string arguments, string cwd) {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        ProcessInfo child = new ProcessInfo();
        try {
            var limits = new ExtendedLimits();
            limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception();
            var startup = new StartupInfo();
            startup.cb = (uint)Marshal.SizeOf(startup);
            if (!CreateProcess(executable, new StringBuilder("\"" + executable + "\" " + arguments), IntPtr.Zero, IntPtr.Zero, false, 4, IntPtr.Zero, cwd, ref startup, out child)) throw new Win32Exception();
            process = child.process;
            Id = child.processId;
            if (!AssignProcessToJobObject(job, process)) throw new Win32Exception();
            if (ResumeThread(child.thread) == uint.MaxValue) throw new Win32Exception();
        } catch {
            if (process != IntPtr.Zero) TerminateProcess(process, 1);
            Dispose();
            throw;
        } finally {
            if (child.thread != IntPtr.Zero) CloseHandle(child.thread);
        }
    }
    public uint ActiveCount {
        get {
            Accounting info;
            if (!QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Win32Exception();
            return info.activeProcesses;
        }
    }
    public uint ExitCode {
        get {
            uint code;
            if (!GetExitCodeProcess(process, out code)) throw new Win32Exception();
            return code;
        }
    }
    public IntPtr[] VisibleWindows() {
        var windows = new List<IntPtr>();
        EnumWindows((window, _) => {
            uint pid;
            GetWindowThreadProcessId(window, out pid);
            if (pid == Id && IsWindowVisible(window)) windows.Add(window);
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
    public static uint ProcessIdForWindow(IntPtr window) {
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        return pid;
    }
    public bool IsDisplayedAppWindow(IntPtr window, bool descendant) {
        uint pid = ProcessIdForWindow(window);
        if (pid == 0 || (descendant ? pid == Id : pid != Id)) return false;
        // PID/executable names alone are not ownership evidence. Keep the
        // process handle open while checking membership in this exact job.
        IntPtr candidate = OpenProcess(0x1000, false, pid); // QUERY_LIMITED_INFORMATION
        if (candidate == IntPtr.Zero) return false;
        try {
            bool belongs;
            if (!IsProcessInJob(candidate, job, out belongs) || !belongs) return false;
            if (!IsWindowVisible(window) || IsIconic(window)) return false;
            uint cloaked;
            if (DwmGetWindowAttribute(window, 14, out cloaked, 4) != 0 || cloaked != 0) return false;
            var name = new StringBuilder(256);
            if (GetClassName(window, name, name.Capacity) == 0 || name.ToString() != "Chrome_WidgetWin_1") return false;
            Rect rect;
            if (!GetWindowRect(window, out rect) || rect.right - rect.left < 320 || rect.bottom - rect.top < 150) return false;
            // An offscreen or covered window is not displayed proof. Observe,
            // never restore/show/focus it to repair a startup visibility bug.
            var center = new Point { x = rect.left + (rect.right - rect.left) / 2, y = rect.top + (rect.bottom - rect.top) / 2 };
            return GetAncestor(WindowFromPoint(center), 2) == window; // GA_ROOT
        } finally {
            CloseHandle(candidate);
        }
    }
    public IntPtr[] DisplayedAppWindows(bool descendant) {
        var windows = new List<IntPtr>();
        EnumWindows((window, _) => {
            if (IsDisplayedAppWindow(window, descendant)) windows.Add(window);
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
    public void Dispose() {
        // Closing the job first also terminates descendants if the root exited.
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
        if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
    }
}
