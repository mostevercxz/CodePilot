"use client";

import { useState } from "react";
import { Plus, Trash } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/hooks/useTranslation";
import type { RemoteConnection } from "@/types";

const DEFAULT_ENV_VARS: Record<string, string> = {
  HTTPS_PROXY: "http://127.0.0.1:28080",
  HTTP_PROXY: "http://127.0.0.1:28080",
  NO_PROXY: "127.0.0.1,172.17.0.0/16,192.168.0.0/16",
};

interface RemoteConnectionFormProps {
  connection?: RemoteConnection | null;
  onSave: (data: Record<string, unknown>) => void;
  onCancel: () => void;
}

export function RemoteConnectionForm({
  connection,
  onSave,
  onCancel,
}: RemoteConnectionFormProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(connection?.name || "");
  const [host, setHost] = useState(connection?.host || "");
  const [port, setPort] = useState(connection?.port || 22);
  const [username, setUsername] = useState(connection?.username || "");
  const [authMethod, setAuthMethod] = useState<string>(connection?.auth_method || "key");
  const [privateKeyPath, setPrivateKeyPath] = useState(
    connection?.private_key_path || "~/.ssh/id_rsa"
  );
  const [password, setPassword] = useState("");
  const [claudeBinaryPath, setClaudeBinaryPath] = useState(
    connection?.claude_binary_path || ""
  );
  const [defaultWorkingDirectory, setDefaultWorkingDirectory] = useState(
    connection?.default_working_directory || ""
  );

  // Parse existing env_vars or use defaults for new connections
  const initEnvVars = (): Array<[string, string]> => {
    if (connection?.env_vars) {
      try {
        const parsed = JSON.parse(connection.env_vars);
        const entries = Object.entries(parsed) as Array<[string, string]>;
        return entries.length > 0 ? entries : Object.entries(DEFAULT_ENV_VARS) as Array<[string, string]>;
      } catch { /* fall through */ }
    }
    return Object.entries(DEFAULT_ENV_VARS) as Array<[string, string]>;
  };
  const [envVarsList, setEnvVarsList] = useState<Array<[string, string]>>(initEnvVars);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Build env_vars JSON from list
    const envObj: Record<string, string> = {};
    for (const [k, v] of envVarsList) {
      if (k.trim()) envObj[k.trim()] = v;
    }
    onSave({
      name,
      host,
      port,
      username,
      auth_method: authMethod,
      private_key_path: authMethod === "key" ? privateKeyPath : "",
      ...(authMethod === "password" && password ? { password } : {}),
      claude_binary_path: claudeBinaryPath,
      default_working_directory: defaultWorkingDirectory,
      env_vars: JSON.stringify(envObj),
    });
  };

  const inputClass =
    "w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring";
  const labelClass = "block text-sm font-medium mb-1";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <h3 className="font-medium">
        {connection ? t("remote.editConnection") : t("remote.newConnection")}
      </h3>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>{t("remote.form.name")}</label>
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("remote.form.namePlaceholder")}
            required
          />
        </div>
        <div>
          <label className={labelClass}>{t("remote.form.host")}</label>
          <input
            className={inputClass}
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="example.com"
            required
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className={labelClass}>{t("remote.form.port")}</label>
          <input
            className={inputClass}
            type="number"
            value={port}
            onChange={(e) => setPort(parseInt(e.target.value) || 22)}
          />
        </div>
        <div>
          <label className={labelClass}>{t("remote.form.username")}</label>
          <input
            className={inputClass}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>
        <div>
          <label className={labelClass}>{t("remote.form.authMethod")}</label>
          <select
            className={inputClass}
            value={authMethod}
            onChange={(e) => setAuthMethod(e.target.value)}
          >
            <option value="key">{t("remote.form.authKey")}</option>
            <option value="password">{t("remote.form.authPassword")}</option>
            <option value="agent">{t("remote.form.authAgent")}</option>
          </select>
        </div>
      </div>

      {authMethod === "key" && (
        <div>
          <label className={labelClass}>{t("remote.form.privateKeyPath")}</label>
          <input
            className={inputClass}
            value={privateKeyPath}
            onChange={(e) => setPrivateKeyPath(e.target.value)}
            placeholder="~/.ssh/id_rsa"
          />
        </div>
      )}

      {authMethod === "password" && (
        <div>
          <label className={labelClass}>{t("remote.form.password")}</label>
          <input
            className={inputClass}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={connection ? t("remote.form.passwordUnchanged") : ""}
          />
        </div>
      )}

      <div>
        <label className={labelClass}>{t("remote.form.claudePath")}</label>
        <input
          className={inputClass}
          value={claudeBinaryPath}
          onChange={(e) => setClaudeBinaryPath(e.target.value)}
          placeholder={t("remote.form.claudePathPlaceholder")}
        />
      </div>

      <div>
        <label className={labelClass}>{t("remote.form.defaultDir")}</label>
        <input
          className={inputClass}
          value={defaultWorkingDirectory}
          onChange={(e) => setDefaultWorkingDirectory(e.target.value)}
          placeholder={t("remote.form.defaultDirPlaceholder")}
        />
      </div>

      {/* Environment Variables */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className={labelClass}>{t("remote.form.envVars")}</label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={() => setEnvVarsList([...envVarsList, ["", ""]])}
          >
            <Plus size={12} className="mr-1" />
            {t("remote.form.addEnvVar")}
          </Button>
        </div>
        <div className="space-y-1.5">
          {envVarsList.map(([key, value], idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                className={`${inputClass} w-2/5 font-mono text-xs`}
                value={key}
                onChange={(e) => {
                  const next = [...envVarsList];
                  next[idx] = [e.target.value, value];
                  setEnvVarsList(next);
                }}
                placeholder="KEY"
              />
              <span className="text-muted-foreground">=</span>
              <input
                className={`${inputClass} flex-1 font-mono text-xs`}
                value={value}
                onChange={(e) => {
                  const next = [...envVarsList];
                  next[idx] = [key, e.target.value];
                  setEnvVarsList(next);
                }}
                placeholder="value"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                onClick={() => setEnvVarsList(envVarsList.filter((_, i) => i !== idx))}
              >
                <Trash size={12} />
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          {t("remote.form.cancel")}
        </Button>
        <Button type="submit" size="sm">
          {connection ? t("remote.form.update") : t("remote.form.create")}
        </Button>
      </div>
    </form>
  );
}
