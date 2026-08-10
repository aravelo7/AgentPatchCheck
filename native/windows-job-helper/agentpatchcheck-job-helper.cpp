#include <windows.h>

#include <iostream>
#include <string>
#include <vector>

namespace {
constexpr wchar_t kHelperVersion[] = L"1.0.0";
constexpr int kProtocolVersion = 1;

struct Options {
	DWORD timeoutMs{};
	SIZE_T memoryLimitBytes{};
	DWORD cpuRate{};
	std::wstring cwd;
	std::vector<std::wstring> command;
};

std::wstring quoteArgument(const std::wstring& value) {
	if (value.find_first_of(L" \t\"") == std::wstring::npos) return value;
	std::wstring quoted = L"\"";
	size_t slashCount = 0;
	for (wchar_t character : value) {
		if (character == L'\\') {
			++slashCount;
			continue;
		}
		if (character == L'\"') quoted.append(slashCount * 2 + 1, L'\\');
		else quoted.append(slashCount, L'\\');
		quoted.push_back(character);
		slashCount = 0;
	}
	quoted.append(slashCount * 2, L'\\');
	quoted.push_back(L'\"');
	return quoted;
}

void writeResult(const char* status, DWORD exitCode, const char* reason, DWORD errorCode = 0) {
	std::cout << "{\"protocolVersion\":1,\"helperVersion\":\"1.0.0\",\"status\":\"" << status
		<< "\",\"exitCode\":" << exitCode << ",\"terminationReason\":\"" << reason
		<< "\",\"errorCode\":" << errorCode << "}" << std::endl;
}

bool parseOptions(int argc, wchar_t** argv, Options* options) {
	int index = 1;
	for (; index < argc; ++index) {
		const std::wstring argument(argv[index]);
		if (argument == L"--") {
			for (++index; index < argc; ++index) options->command.emplace_back(argv[index]);
			break;
		}
		if (index + 1 >= argc) return false;
		const std::wstring value(argv[++index]);
		if (argument == L"--cwd") {
			options->cwd = value;
			continue;
		}
		try {
			const auto number = std::stoull(value);
			if (argument == L"--timeout-ms" && number > 0 && number <= MAXDWORD) options->timeoutMs = static_cast<DWORD>(number);
			else if (argument == L"--memory-bytes" && number > 0 && number <= SIZE_MAX) options->memoryLimitBytes = static_cast<SIZE_T>(number);
			else if (argument == L"--cpu-rate" && number >= 1 && number <= 10000) options->cpuRate = static_cast<DWORD>(number);
			else return false;
		} catch (...) { return false; }
	}
	return options->timeoutMs > 0 && options->memoryLimitBytes > 0 && options->cpuRate > 0 && !options->cwd.empty() && !options->command.empty();
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
	if (argc == 2 && std::wstring(argv[1]) == L"--version") {
		std::cout << "{\"protocolVersion\":1,\"helperVersion\":\"1.0.0\"}" << std::endl;
		return 0;
	}
	Options options;
	if (!parseOptions(argc, argv, &options)) {
		writeResult("error", 0, "invalid-arguments", ERROR_INVALID_PARAMETER);
		return 2;
	}

	HANDLE job = CreateJobObjectW(nullptr, nullptr);
	if (job == nullptr) { writeResult("error", 0, "job-create-failed", GetLastError()); return 3; }
	JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
	limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_JOB_MEMORY;
	limits.JobMemoryLimit = options.memoryLimitBytes;
	if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
		const DWORD error = GetLastError(); CloseHandle(job); writeResult("error", 0, "memory-limit-failed", error); return 4;
	}
	JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu{};
	cpu.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
	cpu.CpuRate = options.cpuRate;
	if (!SetInformationJobObject(job, JobObjectCpuRateControlInformation, &cpu, sizeof(cpu))) {
		const DWORD error = GetLastError(); CloseHandle(job); writeResult("error", 0, "cpu-limit-failed", error); return 5;
	}

	std::wstring commandLine;
	for (const auto& argument : options.command) {
		if (!commandLine.empty()) commandLine.push_back(L' ');
		commandLine += quoteArgument(argument);
	}
	std::vector<wchar_t> mutableCommand(commandLine.begin(), commandLine.end());
	mutableCommand.push_back(L'\0');
	STARTUPINFOW startup{};
	startup.cb = sizeof(startup);
	PROCESS_INFORMATION process{};
	if (!CreateProcessW(options.command.front().c_str(), mutableCommand.data(), nullptr, nullptr, FALSE,
		CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, nullptr, options.cwd.c_str(), &startup, &process)) {
		const DWORD error = GetLastError(); CloseHandle(job); writeResult("error", 0, "process-create-failed", error); return 6;
	}
	if (!AssignProcessToJobObject(job, process.hProcess)) {
		const DWORD error = GetLastError(); TerminateProcess(process.hProcess, ERROR_ACCESS_DENIED); CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job); writeResult("error", 0, "job-assign-failed", error); return 7;
	}
	if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
		const DWORD error = GetLastError(); TerminateJobObject(job, ERROR_PROCESS_ABORTED); CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job); writeResult("error", 0, "process-resume-failed", error); return 8;
	}
	const DWORD wait = WaitForSingleObject(process.hProcess, options.timeoutMs);
	if (wait == WAIT_TIMEOUT) {
		TerminateJobObject(job, ERROR_TIMEOUT);
		WaitForSingleObject(process.hProcess, INFINITE);
		CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job); writeResult("timed-out", ERROR_TIMEOUT, "timeout"); return 0;
	}
	if (wait != WAIT_OBJECT_0) {
		const DWORD error = GetLastError(); TerminateJobObject(job, ERROR_PROCESS_ABORTED); CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job); writeResult("error", 0, "wait-failed", error); return 9;
	}
	DWORD exitCode = 0;
	GetExitCodeProcess(process.hProcess, &exitCode);
	CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job);
	writeResult("exited", exitCode, "completed");
	return 0;
}
