import styles from "./page-header.module.css";

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className={styles["root"]}>
      <h1>{title}</h1>
      {description === undefined ? null : <p className={styles["description"]}>{description}</p>}
    </div>
  );
}
