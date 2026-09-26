output "host" {
  description = "Private, administrable qualification host; no PostgreSQL process or data is installed."
  value = {
    instance_id = aws_instance.host.id
    private_ip  = aws_instance.host.private_ip
    subnet_id   = data.aws_subnet.database.id
    profile     = aws_iam_instance_profile.host.name
  }
}

output "data_volume" {
  description = "Independent encrypted gp3 volume; retain through instance replacement."
  value = {
    id                = aws_ebs_volume.data.id
    availability_zone = aws_ebs_volume.data.availability_zone
    size_gib          = aws_ebs_volume.data.size
  }
}

output "ssm_endpoints" {
  description = "Private administration endpoints; verify service registration and an actual session."
  value       = { for service, endpoint in aws_vpc_endpoint.ssm : service => endpoint.id }
}
