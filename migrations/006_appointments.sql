CREATE TABLE IF NOT EXISTS appointments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contact_id BIGINT UNSIGNED NOT NULL,
  starts_at DATETIME(3) NOT NULL,
  ends_at DATETIME(3) NOT NULL,
  service_requested VARCHAR(255) NULL,
  status ENUM('booked','cancelled') NOT NULL DEFAULT 'booked',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_appointments_availability (status,starts_at,ends_at),
  KEY idx_appointments_contact (contact_id,status,starts_at),
  CONSTRAINT fk_appointments_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
