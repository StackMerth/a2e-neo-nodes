import type Docker from 'dockerode';
import { securityLogger } from '../utils/logger.js';

const log = securityLogger();

/**
 * Sandbox Profile
 */
/**
 * Network policy for fine-grained container network control
 */
export interface NetworkPolicy {
  allowDns: boolean;
  allowedCidrs: string[];   // Allowed outbound CIDR ranges
  blockedCidrs: string[];   // Blocked outbound CIDR ranges
  allowedPorts: number[];   // Allowed outbound ports (empty = all)
  blockedPorts: number[];   // Blocked outbound ports
}

export interface SandboxProfile {
  name: string;
  dropCapabilities: string[];
  addCapabilities: string[];
  seccompProfile?: string;
  readOnlyRootfs: boolean;
  noNewPrivileges: boolean;
  runAsUser?: number;
  runAsGroup?: number;
  usernsMode?: string; // 'host' or empty for remapping
  networkMode: 'bridge' | 'none' | 'host';
  networkPolicy?: NetworkPolicy;
  tmpfsMounts: Record<string, string>;
  ulimits: Array<{ name: string; soft: number; hard: number }>;
  pidsLimit: number;
}

/**
 * Default sandbox profiles
 */
export const SANDBOX_PROFILES: Record<string, SandboxProfile> = {
  /**
   * Strict profile - Maximum isolation for untrusted workloads
   */
  strict: {
    name: 'strict',
    dropCapabilities: ['ALL'],
    addCapabilities: [],
    readOnlyRootfs: true,
    noNewPrivileges: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    usernsMode: '', // Enable user namespace remapping
    networkMode: 'none',
    networkPolicy: {
      allowDns: false,
      allowedCidrs: [],
      blockedCidrs: ['0.0.0.0/0'], // Block all outbound
      allowedPorts: [],
      blockedPorts: [],
    },
    tmpfsMounts: {
      '/tmp': 'rw,noexec,nosuid,size=1g',
      '/var/tmp': 'rw,noexec,nosuid,size=512m',
    },
    ulimits: [
      { name: 'nofile', soft: 1024, hard: 1024 },
      { name: 'nproc', soft: 256, hard: 256 },
    ],
    pidsLimit: 256,
  },

  /**
   * Standard profile - Balanced security for typical GPU workloads
   */
  standard: {
    name: 'standard',
    dropCapabilities: ['ALL'],
    addCapabilities: ['SYS_PTRACE'], // Needed for some debuggers/profilers
    readOnlyRootfs: true,
    noNewPrivileges: true,
    usernsMode: '', // Enable user namespace remapping
    networkMode: 'bridge',
    networkPolicy: {
      allowDns: true,
      allowedCidrs: [],             // Empty = allow all (rely on blockedCidrs)
      blockedCidrs: [
        '169.254.169.254/32',       // Block cloud metadata endpoint
        '10.0.0.0/8',               // Block internal network access
        '172.16.0.0/12',            // Block internal network access
        '192.168.0.0/16',           // Block internal network access
      ],
      allowedPorts: [80, 443, 8080, 8443], // HTTP/HTTPS only
      blockedPorts: [22, 25, 3306, 5432, 6379, 27017], // Block SSH, SMTP, DB ports
    },
    tmpfsMounts: {
      '/tmp': 'rw,noexec,nosuid,size=2g',
      '/var/tmp': 'rw,noexec,nosuid,size=1g',
    },
    ulimits: [
      { name: 'nofile', soft: 65536, hard: 65536 },
      { name: 'nproc', soft: 4096, hard: 4096 },
    ],
    pidsLimit: 4096,
  },

  /**
   * Permissive profile - Minimal restrictions for trusted workloads
   */
  permissive: {
    name: 'permissive',
    dropCapabilities: [
      'AUDIT_WRITE',
      'MKNOD',
      'NET_RAW',
      'SETFCAP',
      'SYS_ADMIN',
      'SYS_BOOT',
      'SYS_MODULE',
      'SYS_RAWIO',
      'SYS_TIME',
    ],
    addCapabilities: ['SYS_PTRACE'],
    readOnlyRootfs: false,
    noNewPrivileges: true,
    usernsMode: 'host', // Share host user namespace (trusted workloads)
    networkMode: 'bridge',
    networkPolicy: {
      allowDns: true,
      allowedCidrs: [],             // No restrictions
      blockedCidrs: [
        '169.254.169.254/32',       // Still block cloud metadata
      ],
      allowedPorts: [],             // All ports allowed
      blockedPorts: [],
    },
    tmpfsMounts: {},
    ulimits: [
      { name: 'nofile', soft: 65536, hard: 65536 },
      { name: 'nproc', soft: 8192, hard: 8192 },
    ],
    pidsLimit: 8192,
  },
};

/**
 * Container Sandbox Manager
 */
export class ContainerSandbox {
  private readonly profile: SandboxProfile;

  constructor(profileName: string = 'standard') {
    const profile = SANDBOX_PROFILES[profileName];
    if (!profile) {
      log.warn({ profileName }, 'Unknown sandbox profile, using standard');
      this.profile = SANDBOX_PROFILES['standard']!;
    } else {
      this.profile = profile;
    }
    log.info({ profile: this.profile.name }, 'Initialized container sandbox');
  }

  /**
   * Apply sandbox settings to container host config
   */
  applyToHostConfig(hostConfig: Docker.HostConfig): Docker.HostConfig {
    // Capabilities
    if (this.profile.dropCapabilities.length > 0) {
      hostConfig.CapDrop = this.profile.dropCapabilities;
    }
    if (this.profile.addCapabilities.length > 0) {
      hostConfig.CapAdd = this.profile.addCapabilities;
    }

    // Read-only root filesystem
    if (this.profile.readOnlyRootfs) {
      hostConfig.ReadonlyRootfs = true;
    }

    // Security options
    const securityOpt: string[] = hostConfig.SecurityOpt ?? [];

    if (this.profile.noNewPrivileges) {
      securityOpt.push('no-new-privileges:true');
    }

    if (this.profile.seccompProfile) {
      securityOpt.push(`seccomp=${this.profile.seccompProfile}`);
    }

    if (securityOpt.length > 0) {
      hostConfig.SecurityOpt = securityOpt;
    }

    // Tmpfs mounts
    if (Object.keys(this.profile.tmpfsMounts).length > 0) {
      hostConfig.Tmpfs = this.profile.tmpfsMounts;
    }

    // Ulimits
    if (this.profile.ulimits.length > 0) {
      hostConfig.Ulimits = this.profile.ulimits.map(u => ({
        Name: u.name,
        Soft: u.soft,
        Hard: u.hard,
      }));
    }

    // PID limit
    if (this.profile.pidsLimit > 0) {
      hostConfig.PidsLimit = this.profile.pidsLimit;
    }

    // User namespace mode
    if (this.profile.usernsMode !== undefined) {
      hostConfig.UsernsMode = this.profile.usernsMode;
    }

    // Network mode
    if (this.profile.networkMode !== 'bridge') {
      hostConfig.NetworkMode = this.profile.networkMode;
    }

    log.debug(
      { profile: this.profile.name },
      'Applied sandbox settings to container'
    );

    return hostConfig;
  }

  /**
   * Apply user settings to container config
   */
  applyUserConfig(config: Docker.ContainerCreateOptions): Docker.ContainerCreateOptions {
    if (this.profile.runAsUser !== undefined) {
      const user = this.profile.runAsGroup !== undefined
        ? `${this.profile.runAsUser}:${this.profile.runAsGroup}`
        : `${this.profile.runAsUser}`;
      config.User = user;
    }

    return config;
  }

  /**
   * Get current profile
   */
  getProfile(): SandboxProfile {
    return this.profile;
  }

  /**
   * Get network policy for the current profile
   */
  getNetworkPolicy(): NetworkPolicy | undefined {
    return this.profile.networkPolicy;
  }

  /**
   * Generate iptables rules for the container's network policy.
   * These should be applied to the container's network namespace after creation.
   */
  generateNetworkRules(containerId: string): string[] {
    const policy = this.profile.networkPolicy;
    if (!policy || this.profile.networkMode === 'none') {
      return []; // No network = no rules needed
    }

    const rules: string[] = [];
    const chain = `A2E-${containerId.substring(0, 12)}`;

    // Create a custom chain
    rules.push(`iptables -N ${chain} 2>/dev/null || true`);

    // Allow established connections
    rules.push(`iptables -A ${chain} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`);

    // Allow loopback
    rules.push(`iptables -A ${chain} -o lo -j ACCEPT`);

    // Allow DNS if permitted
    if (policy.allowDns) {
      rules.push(`iptables -A ${chain} -p udp --dport 53 -j ACCEPT`);
      rules.push(`iptables -A ${chain} -p tcp --dport 53 -j ACCEPT`);
    }

    // Block specific CIDRs
    for (const cidr of policy.blockedCidrs) {
      rules.push(`iptables -A ${chain} -d ${cidr} -j DROP`);
    }

    // Allow specific CIDRs (if specified, only these are allowed)
    if (policy.allowedCidrs.length > 0) {
      for (const cidr of policy.allowedCidrs) {
        rules.push(`iptables -A ${chain} -d ${cidr} -j ACCEPT`);
      }
      rules.push(`iptables -A ${chain} -j DROP`); // Drop everything else
    }

    // Block specific ports
    for (const port of policy.blockedPorts) {
      rules.push(`iptables -A ${chain} -p tcp --dport ${port} -j DROP`);
      rules.push(`iptables -A ${chain} -p udp --dport ${port} -j DROP`);
    }

    // Allow only specific ports (if specified)
    if (policy.allowedPorts.length > 0) {
      for (const port of policy.allowedPorts) {
        rules.push(`iptables -A ${chain} -p tcp --dport ${port} -j ACCEPT`);
      }
      rules.push(`iptables -A ${chain} -p tcp -j DROP`); // Drop non-allowed TCP
    }

    return rules;
  }

  /**
   * Validate container configuration against security requirements
   */
  validateConfig(config: Docker.ContainerCreateOptions): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    // Check for privileged mode
    if (config.HostConfig?.Privileged) {
      issues.push('Container is running in privileged mode');
    }

    // Check for dangerous capabilities
    const dangerousCaps = ['SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE', 'SYS_MODULE'];
    const addedCaps = config.HostConfig?.CapAdd ?? [];
    for (const cap of dangerousCaps) {
      if (addedCaps.includes(cap) && !this.profile.addCapabilities.includes(cap)) {
        issues.push(`Container requests dangerous capability: ${cap}`);
      }
    }

    // Check for host network
    if (config.HostConfig?.NetworkMode === 'host') {
      issues.push('Container is using host network mode');
    }

    // Check for host PID namespace
    if (config.HostConfig?.PidMode === 'host') {
      issues.push('Container is using host PID namespace');
    }

    // Check for host user namespace (less isolation)
    if (config.HostConfig?.UsernsMode === 'host' && this.profile.usernsMode !== 'host') {
      issues.push('Container is using host user namespace, reducing isolation');
    }

    // Check for dangerous mounts
    const binds = config.HostConfig?.Binds ?? [];
    const dangerousPaths = ['/etc', '/var/run/docker.sock', '/proc', '/sys'];
    for (const bind of binds) {
      const hostPath = bind.split(':')[0];
      for (const dangerous of dangerousPaths) {
        if (hostPath?.startsWith(dangerous)) {
          issues.push(`Container mounts dangerous path: ${hostPath}`);
        }
      }
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }
}

/**
 * Create a default seccomp profile for GPU workloads
 */
export function createGpuSeccompProfile(): object {
  // This is a permissive seccomp profile that allows GPU operations
  // In production, this should be more restrictive based on actual needs
  return {
    defaultAction: 'SCMP_ACT_ERRNO',
    architectures: ['SCMP_ARCH_X86_64', 'SCMP_ARCH_X86', 'SCMP_ARCH_X32'],
    syscalls: [
      // Standard syscalls
      { names: ['read', 'write', 'open', 'close', 'stat', 'fstat', 'lstat'], action: 'SCMP_ACT_ALLOW' },
      { names: ['poll', 'lseek', 'mmap', 'mprotect', 'munmap', 'brk'], action: 'SCMP_ACT_ALLOW' },
      { names: ['rt_sigaction', 'rt_sigprocmask', 'rt_sigreturn'], action: 'SCMP_ACT_ALLOW' },
      { names: ['ioctl', 'access', 'pipe', 'select', 'sched_yield'], action: 'SCMP_ACT_ALLOW' },
      { names: ['mremap', 'msync', 'mincore', 'madvise'], action: 'SCMP_ACT_ALLOW' },
      { names: ['shmget', 'shmat', 'shmctl', 'shmdt'], action: 'SCMP_ACT_ALLOW' },
      { names: ['dup', 'dup2', 'pause', 'nanosleep', 'getitimer', 'alarm', 'setitimer'], action: 'SCMP_ACT_ALLOW' },
      { names: ['getpid', 'sendfile', 'socket', 'connect', 'accept'], action: 'SCMP_ACT_ALLOW' },
      { names: ['sendto', 'recvfrom', 'sendmsg', 'recvmsg', 'shutdown'], action: 'SCMP_ACT_ALLOW' },
      { names: ['bind', 'listen', 'getsockname', 'getpeername', 'socketpair'], action: 'SCMP_ACT_ALLOW' },
      { names: ['setsockopt', 'getsockopt', 'clone', 'fork', 'vfork', 'execve'], action: 'SCMP_ACT_ALLOW' },
      { names: ['exit', 'wait4', 'kill', 'uname', 'semget', 'semop', 'semctl'], action: 'SCMP_ACT_ALLOW' },
      { names: ['fcntl', 'flock', 'fsync', 'fdatasync', 'truncate', 'ftruncate'], action: 'SCMP_ACT_ALLOW' },
      { names: ['getdents', 'getcwd', 'chdir', 'fchdir', 'rename'], action: 'SCMP_ACT_ALLOW' },
      { names: ['mkdir', 'rmdir', 'creat', 'link', 'unlink', 'symlink', 'readlink'], action: 'SCMP_ACT_ALLOW' },
      { names: ['chmod', 'fchmod', 'chown', 'fchown', 'lchown', 'umask'], action: 'SCMP_ACT_ALLOW' },
      { names: ['gettimeofday', 'getrlimit', 'getrusage', 'sysinfo', 'times'], action: 'SCMP_ACT_ALLOW' },
      { names: ['ptrace'], action: 'SCMP_ACT_ALLOW' }, // Needed for debugging
      { names: ['getuid', 'getgid', 'setuid', 'setgid', 'geteuid', 'getegid'], action: 'SCMP_ACT_ALLOW' },
      { names: ['setpgid', 'getppid', 'getpgrp', 'setsid', 'setreuid', 'setregid'], action: 'SCMP_ACT_ALLOW' },
      { names: ['getgroups', 'setgroups', 'setresuid', 'getresuid', 'setresgid', 'getresgid'], action: 'SCMP_ACT_ALLOW' },
      { names: ['getpgid', 'setfsuid', 'setfsgid', 'getsid', 'capget', 'capset'], action: 'SCMP_ACT_ALLOW' },
      { names: ['rt_sigpending', 'rt_sigtimedwait', 'rt_sigqueueinfo', 'sigaltstack'], action: 'SCMP_ACT_ALLOW' },
      { names: ['utime', 'mknod', 'uselib', 'personality', 'ustat'], action: 'SCMP_ACT_ALLOW' },
      { names: ['statfs', 'fstatfs', 'sysfs', 'getpriority', 'setpriority'], action: 'SCMP_ACT_ALLOW' },
      { names: ['sched_setparam', 'sched_getparam', 'sched_setscheduler', 'sched_getscheduler'], action: 'SCMP_ACT_ALLOW' },
      { names: ['sched_get_priority_max', 'sched_get_priority_min', 'sched_rr_get_interval'], action: 'SCMP_ACT_ALLOW' },
      { names: ['mlock', 'munlock', 'mlockall', 'munlockall', 'vhangup'], action: 'SCMP_ACT_ALLOW' },
      { names: ['prctl', 'arch_prctl'], action: 'SCMP_ACT_ALLOW' },
      { names: ['futex', 'set_thread_area', 'get_thread_area'], action: 'SCMP_ACT_ALLOW' },
      { names: ['set_tid_address', 'set_robust_list', 'get_robust_list'], action: 'SCMP_ACT_ALLOW' },
      { names: ['epoll_create', 'epoll_ctl', 'epoll_wait', 'epoll_pwait', 'epoll_create1'], action: 'SCMP_ACT_ALLOW' },
      { names: ['clock_gettime', 'clock_getres', 'clock_nanosleep'], action: 'SCMP_ACT_ALLOW' },
      { names: ['exit_group', 'waitid', 'tgkill'], action: 'SCMP_ACT_ALLOW' },
      { names: ['openat', 'mkdirat', 'mknodat', 'fchownat', 'futimesat'], action: 'SCMP_ACT_ALLOW' },
      { names: ['newfstatat', 'unlinkat', 'renameat', 'linkat', 'symlinkat', 'readlinkat'], action: 'SCMP_ACT_ALLOW' },
      { names: ['fchmodat', 'faccessat', 'pselect6', 'ppoll'], action: 'SCMP_ACT_ALLOW' },
      { names: ['unshare', 'splice', 'tee', 'sync_file_range', 'vmsplice'], action: 'SCMP_ACT_ALLOW' },
      { names: ['utimensat', 'signalfd', 'timerfd_create', 'eventfd'], action: 'SCMP_ACT_ALLOW' },
      { names: ['fallocate', 'timerfd_settime', 'timerfd_gettime'], action: 'SCMP_ACT_ALLOW' },
      { names: ['accept4', 'signalfd4', 'eventfd2', 'epoll_create1', 'dup3', 'pipe2'], action: 'SCMP_ACT_ALLOW' },
      { names: ['inotify_init1', 'preadv', 'pwritev', 'rt_tgsigqueueinfo', 'perf_event_open'], action: 'SCMP_ACT_ALLOW' },
      { names: ['recvmmsg', 'fanotify_init', 'fanotify_mark', 'prlimit64', 'name_to_handle_at'], action: 'SCMP_ACT_ALLOW' },
      { names: ['open_by_handle_at', 'clock_adjtime', 'syncfs', 'sendmmsg', 'setns'], action: 'SCMP_ACT_ALLOW' },
      { names: ['getcpu', 'process_vm_readv', 'process_vm_writev', 'kcmp', 'finit_module'], action: 'SCMP_ACT_ALLOW' },
      { names: ['sched_setattr', 'sched_getattr', 'renameat2', 'seccomp', 'getrandom'], action: 'SCMP_ACT_ALLOW' },
      { names: ['memfd_create', 'kexec_file_load', 'bpf'], action: 'SCMP_ACT_ALLOW' },
      { names: ['execveat', 'userfaultfd', 'membarrier', 'mlock2'], action: 'SCMP_ACT_ALLOW' },
      { names: ['copy_file_range', 'preadv2', 'pwritev2', 'pkey_mprotect', 'pkey_alloc', 'pkey_free'], action: 'SCMP_ACT_ALLOW' },
      { names: ['statx', 'io_pgetevents', 'rseq'], action: 'SCMP_ACT_ALLOW' },
    ],
  };
}
