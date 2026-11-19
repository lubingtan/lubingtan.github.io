/*
 * tiny-kvm.c — 用最小代码亲手跑一个 KVM 虚拟机（16 位实模式）
 *
 * 学习目标：直接观察 KVM 的三类 fd 与 KVM_RUN/VM exit 模型：
 *   1) /dev/kvm  --KVM_CREATE_VM-->        VM fd
 *   2) VM fd     --KVM_SET_USER_MEMORY_REGION--> 一段 gpa 指向本进程的用户内存
 *   3) VM fd     --KVM_CREATE_VCPU-->      vCPU fd
 *   4) vCPU fd   --KVM_RUN-->             进入 guest；返回即一次 VM exit
 *
 * guest 代码（放在 gpa 0，16 位实模式）：
 *   B0 41        mov al, 0x41        ; 'A'
 *   E6 E9        out 0xe9, al        ; 0xe9 是未分配的调试端口 -> KVM_EXIT_IO
 *   F4           hlt                 ; -> KVM_EXIT_HLT
 *
 * 编译: gcc -O2 -Wall -Wextra -o tiny-kvm tiny-kvm.c
 * 运行: ./tiny-kvm   (需要 /dev/kvm 且当前用户可读写)
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/kvm.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

#define RAM_SIZE   0x1000ULL          /* 1 页 guest 物理内存 */
#define TSS_ADDR   0xfffbd000ULL      /* Intel VMX 需要的 TSS 区域（不映射也不访问） */

static void die(const char *what)
{
    fprintf(stderr, "%s: %s\n", what, strerror(errno));
    exit(1);
}

int main(void)
{
    int kvm = open("/dev/kvm", O_RDWR | O_CLOEXEC);
    if (kvm < 0) {
        fprintf(stderr, "open /dev/kvm: %s\n", strerror(errno));
        fprintf(stderr, "提示: 确认内核加载了 kvm 模块、/dev/kvm 存在，且当前用户在 kvm 组（或对该设备有 rw 权限）。\n");
        return 1;
    }

    int api = ioctl(kvm, KVM_GET_API_VERSION, 0);
    if (api < 0)
        die("KVM_GET_API_VERSION");
    if (api != KVM_API_VERSION) {
        fprintf(stderr, "unexpected KVM API version %d (expected %d)\n", api, KVM_API_VERSION);
        return 1;
    }
    printf("KVM API version: %d\n", api);

    int vm = ioctl(kvm, KVM_CREATE_VM, 0);
    if (vm < 0)
        die("KVM_CREATE_VM");

    /* Intel VMX 上必须在创建 vCPU 前设置 TSS 地址；AMD 上可忽略失败。 */
    if (ioctl(vm, KVM_SET_TSS_ADDR, TSS_ADDR) < 0)
        fprintf(stderr, "warning: KVM_SET_TSS_ADDR: %s\n", strerror(errno));

    uint8_t *ram = mmap(NULL, RAM_SIZE, PROT_READ | PROT_WRITE,
                        MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (ram == MAP_FAILED)
        die("mmap(guest RAM)");

    struct kvm_userspace_memory_region region = {
        .slot            = 0,
        .flags           = 0,
        .guest_phys_addr = 0,
        .memory_size     = RAM_SIZE,
        .userspace_addr  = (uint64_t)(uintptr_t)ram,
    };
    if (ioctl(vm, KVM_SET_USER_MEMORY_REGION, &region) < 0)
        die("KVM_SET_USER_MEMORY_REGION");

    /* guest 代码：mov al,'A'; out 0xe9,al; hlt */
    static const uint8_t guest_code[] = { 0xB0, 0x41, 0xE6, 0xE9, 0xF4 };
    memcpy(ram, guest_code, sizeof(guest_code));
    printf("guest RAM: hva=%p size=0x%llx, code at gpa 0\n", (void *)ram,
           (unsigned long long)RAM_SIZE);

    int vcpu = ioctl(vm, KVM_CREATE_VCPU, 0);
    if (vcpu < 0)
        die("KVM_CREATE_VCPU");

    int run_size = ioctl(kvm, KVM_GET_VCPU_MMAP_SIZE, 0);
    if (run_size < 0)
        die("KVM_GET_VCPU_MMAP_SIZE");
    struct kvm_run *run = mmap(NULL, run_size, PROT_READ | PROT_WRITE,
                               MAP_SHARED, vcpu, 0);
    if (run == MAP_FAILED)
        die("mmap(kvm_run)");
    printf("vCPU 0 created; kvm_run mmap size = %d bytes\n", run_size);

    /* 把 vCPU 置为 16 位实模式：CS.base=0, RIP=0, CR0.PE=0, EFER=0 */
    struct kvm_sregs sregs;
    if (ioctl(vcpu, KVM_GET_SREGS, &sregs) < 0)
        die("KVM_GET_SREGS");
    struct kvm_segment flat = {
        .selector = 0, .base = 0, .limit = 0xffff,
        .type = 3, .s = 1, .dpl = 0, .present = 1,
        .db = 0, .l = 0, .g = 0,
    };
    sregs.cs = flat;
    sregs.cs.type = 11;               /* code: execute/read/accessed */
    sregs.ds = sregs.es = sregs.fs = sregs.gs = sregs.ss = flat;
    sregs.cr0 = 0x60000010;           /* PE=0（实模式）; CD/NW 按复位值 */
    sregs.cr3 = 0;
    sregs.cr4 = 0;
    sregs.efer = 0;
    if (ioctl(vcpu, KVM_SET_SREGS, &sregs) < 0)
        die("KVM_SET_SREGS");

    struct kvm_regs regs = { .rip = 0, .rflags = 0x2 };
    if (ioctl(vcpu, KVM_SET_REGS, &regs) < 0)
        die("KVM_SET_REGS");

    for (int exits = 0; exits < 8; exits++) {
        if (ioctl(vcpu, KVM_RUN, 0) < 0)
            die("KVM_RUN");

        printf("KVM_RUN -> exit_reason=%u", run->exit_reason);
        switch (run->exit_reason) {
        case KVM_EXIT_IO: {
            uint8_t *data = (uint8_t *)run + run->io.data_offset;
            printf(" (KVM_EXIT_IO) port=0x%x dir=%s size=%u data=0x%02x",
                   run->io.port,
                   run->io.direction == KVM_EXIT_IO_OUT ? "OUT" : "IN",
                   run->io.size, *data);
            if (*data >= 0x20 && *data < 0x7f)
                printf(" '%c'", *data);
            printf("\n");
            break;
        }
        case KVM_EXIT_HLT:
            printf(" (KVM_EXIT_HLT) guest 执行了 hlt\n");
            goto done;
        case KVM_EXIT_SHUTDOWN:
            printf(" (KVM_EXIT_SHUTDOWN) guest triple fault（通常是 vCPU 状态没设对）\n");
            goto done;
        default:
            printf(" (unhandled exit)\n");
            goto done;
        }
    }

done:
    munmap(run, run_size);
    close(vcpu);
    munmap(ram, RAM_SIZE);
    close(vm);
    close(kvm);
    printf("done.\n");
    return 0;
}
