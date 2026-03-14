"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/hooks/useTranslation";
import type { RemoteConnection } from "@/types";

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
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
